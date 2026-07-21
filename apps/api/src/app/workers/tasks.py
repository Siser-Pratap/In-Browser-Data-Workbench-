"""What the worker actually does.

Each task is a plain async function taking `(db, job, deps)` — no ARQ types in
the signature. That keeps the business logic testable by calling it directly,
and means swapping the broker later touches only `worker.py`.
"""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..compute.engine import BoundDataset, ComputeError, EngineSettings, run_query
from ..db.models import Dataset, Job, UsageDaily, Workspace
from ..services.job_service import JobService
from ..services.storage_service import StorageService

logger = logging.getLogger("app.jobs")

# Soft-deleted workspaces are kept this long before the purge job removes them.
RETENTION_DAYS = 30
# An upload that never completed is abandoned after this long.
ORPHAN_UPLOAD_HOURS = 24


class Enqueuer(Protocol):
    """The queue, as the runner needs it.

    Declared here rather than importing `workers.queue` — that module imports
    the runner, which imports this one.
    """

    async def enqueue(self, job_id: uuid.UUID, *, delay_seconds: int = 0) -> None: ...


@dataclass
class TaskDeps:
    jobs: JobService
    storage: StorageService
    engine: EngineSettings
    result_bucket_prefix: str = "compute-results"
    # Set once the queue exists (it needs these deps to be constructed, so the
    # wiring is circular by nature). Without it a retryable failure can only be
    # recorded, not re-attempted.
    queue: Enqueuer | None = None


# -- compute ------------------------------------------------------------------


async def run_compute_query(db: AsyncSession, job: Job, deps: TaskDeps) -> dict[str, Any]:
    """Execute a server-side query and stash the Arrow result in object storage.

    Results go to S3 rather than into the job row: they're megabytes of binary,
    and the client fetches them with an expiring link on its own schedule.
    """
    params = job.params or {}
    sql = params.get("sql", "")
    dataset_ids = params.get("dataset_ids", [])

    datasets = await _bind_datasets(db, job, dataset_ids, deps.storage)
    await deps.jobs.set_progress(db, job, 10)

    result = await run_query(sql, datasets, deps.engine)
    await deps.jobs.set_progress(db, job, 80)

    key = f"{deps.result_bucket_prefix}/{job.id}.arrow"
    deps.storage.put_bytes(key, result.arrow_ipc, "application/vnd.apache.arrow.stream")

    return {
        "result_key": key,
        "row_count": result.row_count,
        "columns": result.column_names,
        "truncated": result.truncated,
        "byte_size": len(result.arrow_ipc),
        "executed_sql": result.sql,
    }


async def _bind_datasets(
    db: AsyncSession, job: Job, dataset_ids: list[str], storage: StorageService
) -> list[BoundDataset]:
    """Resolve the requested datasets to storage URLs.

    Every dataset must live in the job's own workspace — the job row carries the
    workspace the API already authorized, so a crafted `dataset_ids` can't reach
    across tenants.
    """
    import uuid as _uuid

    ids = []
    for raw in dataset_ids:
        try:
            ids.append(_uuid.UUID(str(raw)))
        except (ValueError, TypeError) as exc:
            raise ComputeError(f"Invalid dataset id: {raw}") from exc

    rows = list(
        (
            await db.execute(
                select(Dataset).where(
                    Dataset.id.in_(ids), Dataset.workspace_id == job.workspace_id
                )
            )
        ).scalars()
    )
    if len(rows) != len(ids):
        raise ComputeError("One or more datasets are not available in this workspace")

    bound = []
    for row in rows:
        if row.storage_mode != "uploaded" or not row.storage_key:
            raise ComputeError(
                f"Dataset '{row.name}' has no uploaded file; server compute needs uploaded data"
            )
        bound.append(
            BoundDataset(
                name=row.name,
                url=storage.s3_url(row.storage_key),
                format=(row.format or "parquet").lower(),
            )
        )
    return bound


# -- maintenance --------------------------------------------------------------


async def purge_soft_deleted(db: AsyncSession, job: Job, deps: TaskDeps) -> dict[str, Any]:
    """Hard-delete workspaces past their retention window, storage included."""
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=RETENTION_DAYS)
    stale = list(
        (
            await db.execute(
                select(Workspace).where(
                    Workspace.deleted_at.is_not(None), Workspace.deleted_at < cutoff
                )
            )
        ).scalars()
    )

    purged_objects = 0
    for workspace in stale:
        # Drop the S3 objects before the rows, or the keys become unreachable.
        datasets = (
            await db.execute(select(Dataset).where(Dataset.workspace_id == workspace.id))
        ).scalars()
        for dataset in datasets:
            if dataset.storage_key:
                deps.storage.delete(dataset.storage_key)
                purged_objects += 1
        await db.delete(workspace)

    await db.commit()
    return {"workspaces_purged": len(stale), "objects_deleted": purged_objects}


async def cleanup_orphaned_uploads(db: AsyncSession, job: Job, deps: TaskDeps) -> dict[str, Any]:
    """Clear storage keys reserved by uploads that were never completed.

    `upload-url` reserves a key before the bytes land; if the client vanishes,
    the dataset keeps pointing at an object that may not exist. The S3 lifecycle
    rule removes the object — this removes the dangling reference.
    """
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(hours=ORPHAN_UPLOAD_HOURS)
    stale = list(
        (
            await db.execute(
                select(Dataset).where(
                    Dataset.storage_key.is_not(None),
                    Dataset.storage_mode == "local_only",
                    Dataset.updated_at < cutoff,
                )
            )
        ).scalars()
    )
    for dataset in stale:
        deps.storage.delete(dataset.storage_key or "")
        dataset.storage_key = None
    await db.commit()
    return {"uploads_cleaned": len(stale)}


async def roll_up_usage(db: AsyncSession, job: Job, deps: TaskDeps) -> dict[str, Any]:
    """Summarise yesterday's usage per user into `usage_daily`.

    Runs before `expire_old_jobs` in the nightly sequence, and rolls up the day
    that has already closed — a rollup of *today* would be a partial number that
    later reads as final. Re-running is safe: an existing row for the day is
    overwritten, not added to.
    """
    day = (dt.datetime.now(dt.UTC) - dt.timedelta(days=1)).date()
    start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.UTC)
    end = start + dt.timedelta(days=1)

    finished = list(
        (
            await db.execute(
                select(Job).where(
                    Job.user_id.is_not(None),
                    Job.finished_at.is_not(None),
                    Job.finished_at >= start,
                    Job.finished_at < end,
                )
            )
        ).scalars()
    )

    totals: dict[uuid.UUID, dict[str, int]] = {}
    for row in finished:
        bucket = totals.setdefault(
            row.user_id,
            {
                "compute_jobs": 0,
                "compute_seconds": 0,
                "compute_rows": 0,
                "compute_result_bytes": 0,
                "jobs_failed": 0,
            },
        )
        if row.status == "failed":
            bucket["jobs_failed"] += 1
        if row.kind != "compute_query":
            continue
        bucket["compute_jobs"] += 1
        bucket["compute_seconds"] += _duration_seconds(row)
        result = row.result or {}
        bucket["compute_rows"] += int(result.get("row_count") or 0)
        bucket["compute_result_bytes"] += int(result.get("byte_size") or 0)

    # Storage is a point-in-time reading, not something to sum over the day.
    storage = dict(
        (
            await db.execute(
                select(Workspace.owner_id, func.coalesce(func.sum(Dataset.byte_size), 0))
                .join(Dataset, Dataset.workspace_id == Workspace.id)
                .where(
                    Workspace.deleted_at.is_(None),
                    Dataset.storage_mode == "uploaded",
                )
                .group_by(Workspace.owner_id)
            )
        ).all()
    )

    for user_id in set(totals) | set(storage):
        bucket = totals.get(user_id, {})
        existing = (
            await db.execute(
                select(UsageDaily).where(
                    UsageDaily.user_id == user_id, UsageDaily.day == day
                )
            )
        ).scalar_one_or_none()
        row = existing or UsageDaily(user_id=user_id, day=day)
        row.compute_jobs = bucket.get("compute_jobs", 0)
        row.compute_seconds = bucket.get("compute_seconds", 0)
        row.compute_rows = bucket.get("compute_rows", 0)
        row.compute_result_bytes = bucket.get("compute_result_bytes", 0)
        row.jobs_failed = bucket.get("jobs_failed", 0)
        row.storage_bytes = int(storage.get(user_id, 0) or 0)
        if existing is None:
            db.add(row)

    await db.commit()
    return {"day": day.isoformat(), "users": len(set(totals) | set(storage))}


def _duration_seconds(row: Job) -> int:
    if not (row.started_at and row.finished_at):
        return 0
    started, finished = row.started_at, row.finished_at
    # SQLite returns naive datetimes even for timezone-aware columns.
    if (started.tzinfo is None) != (finished.tzinfo is None):
        started = started.replace(tzinfo=finished.tzinfo)
    return max(int((finished - started).total_seconds()), 0)


async def expire_old_jobs(db: AsyncSession, job: Job, deps: TaskDeps) -> dict[str, Any]:
    """Drop finished job rows (and their result objects) after a week."""
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=7)
    stale = list(
        (
            await db.execute(
                select(Job).where(
                    Job.status.in_(("succeeded", "failed", "cancelled")),
                    Job.finished_at.is_not(None),
                    Job.finished_at < cutoff,
                )
            )
        ).scalars()
    )
    for old in stale:
        key = (old.result or {}).get("result_key")
        if key:
            deps.storage.delete(key)
    await db.execute(delete(Job).where(Job.id.in_([j.id for j in stale])))
    await db.commit()
    return {"jobs_expired": len(stale)}


# The dispatch table the runner and the ARQ worker share.
TASKS = {
    "compute_query": run_compute_query,
    "purge_soft_deleted": purge_soft_deleted,
    "cleanup_orphaned_uploads": cleanup_orphaned_uploads,
    "roll_up_usage": roll_up_usage,
    "expire_old_jobs": expire_old_jobs,
}

# Failures worth another attempt. A rejected query or a missing dataset will
# fail identically every time, so retrying only burns the worker pool.
NON_RETRYABLE = (ComputeError,)
