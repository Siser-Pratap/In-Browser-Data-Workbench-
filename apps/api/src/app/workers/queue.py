"""Enqueueing, with a Redis-free fallback.

`ArqQueue` is the production path. `InlineQueue` runs the job in the current
process as a background task — that keeps `docker compose up` without a worker,
and the whole test suite, working against the same API surface. The API code
only ever sees `JobQueue.enqueue`.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Protocol

from sqlalchemy.ext.asyncio import async_sessionmaker

from .runner import execute_job
from .tasks import TaskDeps

logger = logging.getLogger("app.jobs")

ARQ_TASK_NAME = "run_job"


class JobQueue(Protocol):
    async def enqueue(self, job_id: uuid.UUID, *, delay_seconds: int = 0) -> None: ...
    async def close(self) -> None: ...


class InlineQueue:
    """Runs jobs in-process. Dev and test only — nothing survives a restart."""

    def __init__(self, sessionmaker: async_sessionmaker, deps: TaskDeps) -> None:
        self.sessionmaker = sessionmaker
        self.deps = deps
        self._tasks: set[asyncio.Task] = set()

    async def enqueue(self, job_id: uuid.UUID, *, delay_seconds: int = 0) -> None:
        task = asyncio.create_task(self._run(job_id, delay_seconds))
        # Hold a reference; asyncio only keeps a weak one and will happily
        # garbage-collect a running task mid-flight.
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, job_id: uuid.UUID, delay_seconds: int) -> None:
        if delay_seconds:
            await asyncio.sleep(delay_seconds)
        try:
            await execute_job(self.sessionmaker, job_id, self.deps)
        except Exception:
            logger.exception("job.inline_failed", extra={"job_id": str(job_id)})

    async def drain(self) -> None:
        """Wait for in-flight jobs. Used by tests; a no-op once idle."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()


class ArqQueue:
    """Pushes onto Redis for the ARQ worker pool to pick up."""

    def __init__(self, redis: Any) -> None:
        self.redis = redis

    async def enqueue(self, job_id: uuid.UUID, *, delay_seconds: int = 0) -> None:
        await self.redis.enqueue_job(
            ARQ_TASK_NAME, str(job_id), _defer_by=delay_seconds or None
        )

    async def close(self) -> None:
        await self.redis.close()


async def create_queue(
    redis_url: str, sessionmaker: async_sessionmaker, deps: TaskDeps
) -> JobQueue:
    """Prefer Redis; fall back to inline if it isn't reachable.

    A dev machine without Redis should still be able to run a query, so an
    unreachable broker degrades instead of breaking startup — loudly, because in
    production it means jobs are running on the API process.
    """
    if not redis_url:
        return InlineQueue(sessionmaker, deps)
    try:
        from arq import create_pool
        from arq.connections import RedisSettings

        redis = await create_pool(RedisSettings.from_dsn(redis_url))
        await redis.ping()
        return ArqQueue(redis)
    except Exception as exc:  # noqa: BLE001 — any broker problem means fall back
        logger.warning(
            "jobs.redis_unavailable_running_inline",
            extra={"redis_url": redis_url, "error": str(exc)},
        )
        return InlineQueue(sessionmaker, deps)
