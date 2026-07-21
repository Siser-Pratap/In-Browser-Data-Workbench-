"""Server-side query execution — the big-file fallback.

The browser handles files up to roughly memory size. Beyond that a user can opt
into server compute on **uploaded** datasets: this endpoint authorizes the
request, records a job, and hands back a job id. Nothing executes inline — a
60-second query must not hold an HTTP worker.
"""

from fastapi import APIRouter

from ..compute import sql_guard
from ..compute.engine import SQLRejected
from ..core.deps import CurrentUser, DbSession, Jobs, Queue, Storage, Workspaces
from ..core.ratelimit import rate_limit
from ..schemas.job import ComputeQueryRequest, ComputeResultResponse, JobAcceptedResponse
from ..services.permissions import require
from ..services.storage_service import InvalidUpload
from .jobs import to_job_response

router = APIRouter(prefix="/compute", tags=["compute"])

# Per-IP ceiling on top of the per-user concurrency cap: the cap limits work
# in flight, this limits how fast someone can submit (including submissions
# that get rejected and so never occupy a slot).
_COMPUTE_LIMIT = rate_limit("compute")


@router.post(
    "/queries",
    response_model=JobAcceptedResponse,
    status_code=202,
    operation_id="createComputeQuery",
    dependencies=[_COMPUTE_LIMIT],
)
async def create_compute_query(
    body: ComputeQueryRequest,
    user: CurrentUser,
    db: DbSession,
    jobs: Jobs,
    queue: Queue,
    workspaces: Workspaces,
) -> JobAcceptedResponse:
    workspace = await workspaces.get(db, body.workspace_id)
    # `read_data` rather than `read`: server compute touches the uploaded rows,
    # not just the metadata a share link exposes.
    require("read_data", workspace, user)

    # Reject bad SQL now, synchronously, so the user gets the parse error
    # immediately instead of via a job that fails a second later.
    dataset_names = await _dataset_names(db, workspace, body.dataset_ids)
    guard = sql_guard.check(body.sql, dataset_names)
    if not guard.ok:
        raise SQLRejected(guard.error or "SQL rejected")

    job = await jobs.create(
        db,
        kind="compute_query",
        user=user,
        workspace_id=workspace.id,
        params={"sql": body.sql, "dataset_ids": body.dataset_ids},
        # A rejected query fails identically every time; only infrastructure
        # blips are worth a second attempt.
        max_attempts=2,
    )
    await queue.enqueue(job.id)
    return JobAcceptedResponse(job_id=str(job.id), status=job.status)  # type: ignore[arg-type]


async def _dataset_names(db, workspace, dataset_ids: list[str]) -> list[str]:
    import uuid

    from sqlalchemy import select

    from ..db.models import Dataset

    ids = []
    for raw in dataset_ids:
        try:
            ids.append(uuid.UUID(raw))
        except (ValueError, TypeError) as exc:
            raise InvalidUpload(f"Invalid dataset id: {raw}") from exc

    rows = list(
        (
            await db.execute(
                select(Dataset).where(
                    Dataset.id.in_(ids), Dataset.workspace_id == workspace.id
                )
            )
        ).scalars()
    )
    if len(rows) != len(ids):
        raise InvalidUpload("One or more datasets are not in this workspace")
    missing = [r.name for r in rows if r.storage_mode != "uploaded" or not r.storage_key]
    if missing:
        raise InvalidUpload(
            f"Server compute needs uploaded data; these are local-only: {', '.join(missing)}"
        )
    return [r.name for r in rows]


@router.get(
    "/queries/{job_id}",
    operation_id="getComputeQuery",
)
async def get_compute_query(job_id: str, user: CurrentUser, db: DbSession, jobs: Jobs):
    """Status while running; the job record carries the result summary when done."""
    job = await jobs.get_for_user(db, job_id, user)
    return to_job_response(job)


@router.get(
    "/queries/{job_id}/result",
    response_model=ComputeResultResponse,
    operation_id="getComputeQueryResult",
)
async def get_compute_result(
    job_id: str, user: CurrentUser, db: DbSession, jobs: Jobs, storage: Storage
) -> ComputeResultResponse:
    """An expiring link to the Arrow IPC bytes.

    The API never streams the result itself: it can be hundreds of megabytes,
    and the client already knows how to read Arrow from a URL.
    """
    job = await jobs.get_for_user(db, job_id, user)
    if job.status != "succeeded":
        raise InvalidUpload(f"Job is {job.status}; no result to fetch")

    result = job.result or {}
    key = result.get("result_key")
    if not key:
        raise InvalidUpload("Job produced no result")

    return ComputeResultResponse(
        download_url=storage.presign_get(key),
        expires_in=storage.presign_ttl_seconds,
        row_count=result.get("row_count", 0),
        columns=result.get("columns", []),
        truncated=result.get("truncated", False),
        byte_size=result.get("byte_size", 0),
        executed_sql=result.get("executed_sql", ""),
    )
