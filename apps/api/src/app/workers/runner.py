"""Executes one job and owns its status transitions.

Both entry points — the ARQ worker in production and the inline runner used in
dev/tests — funnel through `execute_job`, so retry, dead-lettering and progress
behave identically no matter who is driving.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import async_sessionmaker

from ..core.logging import job_id_var, request_id_var
from ..db.models.job import TERMINAL_STATUSES
from ..services.job_service import backoff_seconds
from .tasks import NON_RETRYABLE, TASKS, TaskDeps

logger = logging.getLogger("app.jobs")


async def execute_job(
    sessionmaker: async_sessionmaker,
    job_id: str | uuid.UUID,
    deps: TaskDeps,
) -> str:
    """Run one job to a terminal state (or back to `queued` for a retry).

    Returns the resulting status. Each job gets its own session: a worker
    process outlives any single request, and a failed task must not leave a
    poisoned transaction behind for the next one.
    """
    token = job_id_var.set(str(job_id))
    try:
        return await _execute(sessionmaker, job_id, deps)
    finally:
        job_id_var.reset(token)


async def _execute(
    sessionmaker: async_sessionmaker, job_id: str | uuid.UUID, deps: TaskDeps
) -> str:
    async with sessionmaker() as db:
        job = await deps.jobs.get(db, job_id)
        # Carry the originating request's id into the worker's log context.
        request_id = (job.params or {}).get("request_id")
        if request_id:
            request_id_var.set(request_id)

        # A job cancelled while it sat in the queue must not start.
        if job.status in TERMINAL_STATUSES:
            logger.info(
                "job.skipped", extra={"job_id": str(job.id), "status": job.status}
            )
            return job.status

        task = TASKS.get(job.kind)
        if task is None:
            await deps.jobs.mark_failed(db, job, f"Unknown job kind: {job.kind}", retryable=False)
            return "failed"

        await deps.jobs.mark_running(db, job)
        try:
            result = await task(db, job, deps)
        except Exception as exc:  # noqa: BLE001 — the boundary: every failure is a job failure
            await db.rollback()
            job = await deps.jobs.get(db, job_id)
            retryable = not isinstance(exc, NON_RETRYABLE)
            message = getattr(exc, "message", None) or str(exc)
            logger.exception(
                "job.failed", extra={"job_id": str(job.id), "kind": job.kind}
            )
            updated = await deps.jobs.mark_failed(db, job, message, retryable=retryable)
            if updated.status == "queued":
                await _requeue(deps, job_id, updated.attempts)
            return updated.status

        updated = await deps.jobs.mark_succeeded(db, job, result)
        return updated.status


async def _requeue(deps: TaskDeps, job_id: str | uuid.UUID, attempts: int) -> None:
    """Push a retryable failure back onto the queue.

    Setting the row back to `queued` is not enough: nothing polls that column,
    so without a new queue message the job would sit there forever — never
    retried, never dead-lettered, and still counted against the user's
    concurrency cap.
    """
    delay = backoff_seconds(attempts)
    if deps.queue is None:
        logger.error(
            "job.retry_dropped",
            extra={"job_id": str(job_id), "attempts": attempts},
        )
        return
    await deps.queue.enqueue(
        job_id if isinstance(job_id, uuid.UUID) else uuid.UUID(str(job_id)),
        delay_seconds=delay,
    )
    logger.info(
        "job.requeued", extra={"job_id": str(job_id), "retry_in_seconds": delay}
    )
