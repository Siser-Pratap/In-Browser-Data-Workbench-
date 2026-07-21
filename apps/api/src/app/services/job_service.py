"""Job lifecycle: create, claim, progress, finish, retry, dead-letter.

The database row is the source of truth for status; the queue only carries the
"go and do it" signal. That split means a Redis flush loses pending work but
never loses job *history*, and the API can answer `GET /jobs/{id}` without
talking to the broker at all.
"""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.logging import request_id_var
from ..core.metrics import JOB_DURATION, JOBS_TOTAL
from ..db.models import Job, User
from ..db.models.job import TERMINAL_STATUSES
from .errors import AuthError
from .permissions import NotVisible

logger = logging.getLogger("app.jobs")


class TooManyJobs(AuthError):
    status_code = 429
    code = "too_many_jobs"


class JobNotCancellable(AuthError):
    status_code = 409
    code = "job_not_cancellable"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def backoff_seconds(attempt: int, *, base: int = 5, cap: int = 600) -> int:
    """Exponential backoff between retries: 5s, 10s, 20s, ... capped."""
    return min(base * (2 ** max(attempt - 1, 0)), cap)


def _observe(job: Job, status: str) -> None:
    JOBS_TOTAL.labels(kind=job.kind, status=status).inc()
    if job.started_at and job.finished_at:
        started, finished = job.started_at, job.finished_at
        # SQLite hands back naive datetimes even for tz-aware columns.
        if (started.tzinfo is None) != (finished.tzinfo is None):
            started = started.replace(tzinfo=finished.tzinfo)
        JOB_DURATION.labels(kind=job.kind).observe((finished - started).total_seconds())


class JobService:
    def __init__(self, max_concurrent_per_user: int = 2) -> None:
        self.max_concurrent_per_user = max_concurrent_per_user

    # -- creation ------------------------------------------------------------

    async def create(
        self,
        db: AsyncSession,
        *,
        kind: str,
        user: User | None = None,
        workspace_id: uuid.UUID | None = None,
        params: dict[str, Any] | None = None,
        max_attempts: int = 3,
    ) -> Job:
        if user is not None:
            await self._check_concurrency(db, user)
        params = dict(params or {})
        # Stamp the originating request so worker logs can be joined back to the
        # API call that started the work.
        request_id = request_id_var.get()
        if request_id:
            params.setdefault("request_id", request_id)
        job = Job(
            kind=kind,
            user_id=user.id if user else None,
            workspace_id=workspace_id,
            params=params,
            result={},
            status="queued",
            max_attempts=max_attempts,
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        logger.info("job.created", extra={"job_id": str(job.id), "kind": kind})
        return job

    async def _check_concurrency(self, db: AsyncSession, user: User) -> None:
        """Cap in-flight work per user.

        Server compute is the expensive path; without this one user can fill the
        worker pool and stall everyone else.
        """
        active = (
            await db.execute(
                select(func.count(Job.id)).where(
                    Job.user_id == user.id, Job.status.in_(("queued", "running"))
                )
            )
        ).scalar_one()
        if int(active) >= self.max_concurrent_per_user:
            raise TooManyJobs(
                f"You already have {active} jobs running; wait for one to finish"
            )

    # -- lookups -------------------------------------------------------------

    async def get(self, db: AsyncSession, job_id: str | uuid.UUID) -> Job:
        try:
            jid = job_id if isinstance(job_id, uuid.UUID) else uuid.UUID(job_id)
        except (ValueError, TypeError) as exc:
            raise NotVisible("Job not found") from exc
        job = (await db.execute(select(Job).where(Job.id == jid))).scalar_one_or_none()
        if job is None:
            raise NotVisible("Job not found")
        return job

    async def get_for_user(self, db: AsyncSession, job_id: str, user: User) -> Job:
        """Fetch a job the caller owns; anything else is a 404, not a 403.

        Job ids are the only handle on a result, so an attacker must not be able
        to probe which ones exist.
        """
        job = await self.get(db, job_id)
        if job.user_id != user.id:
            raise NotVisible("Job not found")
        return job

    async def list_for_user(
        self, db: AsyncSession, user: User, *, limit: int = 50, offset: int = 0
    ) -> tuple[list[Job], int]:
        base = select(Job).where(Job.user_id == user.id)
        total = (
            await db.execute(select(func.count()).select_from(base.subquery()))
        ).scalar_one()
        rows = (
            await db.execute(base.order_by(Job.created_at.desc()).limit(limit).offset(offset))
        ).scalars()
        return list(rows), int(total)

    # -- transitions ---------------------------------------------------------

    async def mark_running(self, db: AsyncSession, job: Job) -> Job:
        job.status = "running"
        job.attempts += 1
        job.started_at = _now()
        job.error = None
        await db.commit()
        await db.refresh(job)
        return job

    async def set_progress(self, db: AsyncSession, job: Job, progress: int) -> Job:
        job.progress = max(0, min(100, progress))
        await db.commit()
        return job

    async def mark_succeeded(self, db: AsyncSession, job: Job, result: dict[str, Any]) -> Job:
        job.status = "succeeded"
        job.result = result
        job.progress = 100
        job.error = None
        job.finished_at = _now()
        await db.commit()
        await db.refresh(job)
        _observe(job, "succeeded")
        logger.info("job.succeeded", extra={"job_id": str(job.id), "kind": job.kind})
        return job

    async def mark_failed(
        self, db: AsyncSession, job: Job, error: str, *, retryable: bool = True
    ) -> Job:
        """Fail the attempt. Retryable failures with attempts left requeue.

        Returns the job with its new status so the caller can decide whether to
        re-enqueue (`status == "queued"`) or stop.
        """
        job.error = error[:2000]
        if retryable and job.attempts < job.max_attempts:
            job.status = "queued"
            job.started_at = None
            logger.warning(
                "job.retry",
                extra={"job_id": str(job.id), "attempt": job.attempts, "error": error[:200]},
            )
        else:
            job.status = "failed"
            job.finished_at = _now()
            job.dead_lettered_at = _now()
            _observe(job, "failed")
            logger.error(
                "job.dead_letter",
                extra={
                    "job_id": str(job.id),
                    "kind": job.kind,
                    "attempts": job.attempts,
                    "error": error[:200],
                },
            )
        await db.commit()
        await db.refresh(job)
        return job

    async def cancel(self, db: AsyncSession, job: Job) -> Job:
        if job.status in TERMINAL_STATUSES:
            raise JobNotCancellable(f"Job is already {job.status}")
        job.status = "cancelled"
        job.finished_at = _now()
        _observe(job, "cancelled")
        await db.commit()
        await db.refresh(job)
        return job

    # -- maintenance ---------------------------------------------------------

    async def dead_lettered(self, db: AsyncSession, *, limit: int = 100) -> list[Job]:
        rows = (
            await db.execute(
                select(Job)
                .where(Job.dead_lettered_at.is_not(None))
                .order_by(Job.dead_lettered_at.desc())
                .limit(limit)
            )
        ).scalars()
        return list(rows)

    async def queue_depth(self, db: AsyncSession) -> dict[str, int]:
        rows = (
            await db.execute(
                select(Job.status, func.count(Job.id)).group_by(Job.status)
            )
        ).all()
        return {status: int(count) for status, count in rows}
