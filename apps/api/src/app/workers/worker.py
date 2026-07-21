"""ARQ worker entry point.

Run with:  `uv run arq app.workers.worker.WorkerSettings`

The worker builds the same services the API does, from the same settings, and
delegates to `execute_job` — retries and dead-lettering are decided there, not
by ARQ, so the database stays the single source of truth for job status. ARQ's
own retry is therefore disabled (`max_tries=1`).
"""

from __future__ import annotations

import logging

from arq import cron
from arq.connections import RedisSettings

from ..core.config import get_settings
from ..core.logging import configure_logging
from ..db.session import create_database
from ..services.job_service import JobService
from ..services.storage_service import StorageService
from .runner import execute_job
from .tasks import TaskDeps

logger = logging.getLogger("app.jobs")


def build_deps(settings, *, storage: StorageService | None = None, jobs=None) -> TaskDeps:
    """Assemble what the tasks need.

    The API passes in the service instances it already holds, so in-process jobs
    and HTTP handlers share one storage client rather than each building their
    own — two configurations of the same thing is how they drift apart. The
    worker process has no such instances and gets fresh ones.
    """
    from ..compute.engine import EngineSettings

    storage = storage or StorageService(
        bucket=settings.s3_bucket,
        endpoint_url=settings.s3_endpoint_url,
        region=settings.s3_region,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        presign_ttl_seconds=settings.s3_presign_ttl_seconds,
        max_file_bytes=settings.storage_max_file_bytes,
    )
    engine = EngineSettings(
        memory_limit=settings.compute_memory_limit,
        threads=settings.compute_threads,
        timeout_seconds=settings.compute_timeout_seconds,
        max_rows=settings.compute_max_rows,
        s3_endpoint=_host_only(settings.s3_endpoint_url),
        s3_region=settings.s3_region,
        s3_access_key=settings.s3_access_key,
        s3_secret_key=settings.s3_secret_key,
        s3_use_ssl=(settings.s3_endpoint_url or "").startswith("https"),
    )
    return TaskDeps(
        jobs=jobs
        or JobService(max_concurrent_per_user=settings.compute_max_concurrent_per_user),
        storage=storage,
        engine=engine,
    )


def _host_only(url: str | None) -> str | None:
    """DuckDB's `s3_endpoint` wants `host:port`, not a full URL."""
    if not url:
        return None
    return url.split("://", 1)[-1].rstrip("/")


async def startup(ctx: dict) -> None:
    configure_logging()
    settings = get_settings()
    ctx["settings"] = settings
    ctx["database"] = create_database(settings.database_url)
    ctx["deps"] = build_deps(settings)
    logger.info("worker.started")


async def shutdown(ctx: dict) -> None:
    await ctx["database"].dispose()
    logger.info("worker.stopped")


async def run_job(ctx: dict, job_id: str) -> str:
    return await execute_job(ctx["database"].sessionmaker, job_id, ctx["deps"])


async def _system_job(ctx: dict, kind: str) -> str:
    """Create and immediately run a scheduled maintenance job."""
    deps: TaskDeps = ctx["deps"]
    sessionmaker = ctx["database"].sessionmaker
    async with sessionmaker() as db:
        job = await deps.jobs.create(db, kind=kind, max_attempts=1)
        job_id = job.id
    return await execute_job(sessionmaker, job_id, deps)


async def purge_cron(ctx: dict) -> str:
    return await _system_job(ctx, "purge_soft_deleted")


async def cleanup_cron(ctx: dict) -> str:
    return await _system_job(ctx, "cleanup_orphaned_uploads")


async def expire_jobs_cron(ctx: dict) -> str:
    return await _system_job(ctx, "expire_old_jobs")


class WorkerSettings:
    functions = [run_job]
    cron_jobs = [
        # Off-peak, staggered so three table scans don't land together.
        cron(purge_cron, hour=3, minute=0),
        cron(cleanup_cron, hour=3, minute=20),
        cron(expire_jobs_cron, hour=3, minute=40),
    ]
    on_startup = startup
    on_shutdown = shutdown
    # Retries are decided by `execute_job` against the job row, not by ARQ.
    max_tries = 1
    job_timeout = 3600
    # ARQ reads this as a value, not a callable — resolved at import time, which
    # is fine for a process whose only job is to be this worker.
    redis_settings = RedisSettings.from_dsn(
        get_settings().redis_url or "redis://localhost:6379"
    )
