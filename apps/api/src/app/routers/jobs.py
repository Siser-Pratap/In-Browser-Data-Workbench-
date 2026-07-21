"""Generic job status, cancellation, and live progress over SSE."""

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter
from fastapi import Query as QueryParam
from starlette.responses import StreamingResponse

from ..core.deps import CurrentUser, DbSession, Jobs, SessionMaker
from ..db.models import Job
from ..db.models.job import TERMINAL_STATUSES
from ..schemas.job import JobListResponse, JobResponse

router = APIRouter(prefix="/jobs", tags=["jobs"])

# How often the SSE stream re-reads the job row.
_POLL_SECONDS = 1.0
# Stop streaming eventually even if a job never finishes, so a hung worker
# can't pin an open connection forever.
_STREAM_TIMEOUT_SECONDS = 900


def to_job_response(job: Job) -> JobResponse:
    return JobResponse(
        id=str(job.id),
        kind=job.kind,
        status=job.status,  # type: ignore[arg-type]
        progress=job.progress,
        workspace_id=str(job.workspace_id) if job.workspace_id else None,
        result=job.result or {},
        error=job.error,
        attempts=job.attempts,
        max_attempts=job.max_attempts,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
    )


@router.get("", response_model=JobListResponse, operation_id="listJobs")
async def list_jobs(
    user: CurrentUser,
    db: DbSession,
    jobs: Jobs,
    limit: Annotated[int, QueryParam(ge=1, le=100)] = 50,
    offset: Annotated[int, QueryParam(ge=0)] = 0,
) -> JobListResponse:
    items, total = await jobs.list_for_user(db, user, limit=limit, offset=offset)
    return JobListResponse(
        items=[to_job_response(j) for j in items], total=total, limit=limit, offset=offset
    )


@router.get("/{job_id}", response_model=JobResponse, operation_id="getJob")
async def get_job(job_id: str, user: CurrentUser, db: DbSession, jobs: Jobs) -> JobResponse:
    return to_job_response(await jobs.get_for_user(db, job_id, user))


@router.post("/{job_id}/cancel", response_model=JobResponse, operation_id="cancelJob")
async def cancel_job(job_id: str, user: CurrentUser, db: DbSession, jobs: Jobs) -> JobResponse:
    """Mark a job cancelled.

    A queued job never starts; a running one finishes its current attempt (the
    worker checks the row before each transition) — we don't kill mid-query.
    """
    job = await jobs.get_for_user(db, job_id, user)
    return to_job_response(await jobs.cancel(db, job))


@router.get("/{job_id}/events", operation_id="streamJobEvents")
async def stream_job_events(
    job_id: str, user: CurrentUser, db: DbSession, jobs: Jobs, sessionmaker: SessionMaker
):
    """Server-sent events: one `progress` event per change, then `done`.

    Polls the job row on its own short-lived sessions — holding the request's
    session open for fifteen minutes would pin a connection from the pool.
    """
    job = await jobs.get_for_user(db, job_id, user)
    job_id_value = job.id

    async def event_stream():
        elapsed = 0.0
        last_signature: tuple | None = None
        while elapsed < _STREAM_TIMEOUT_SECONDS:
            async with sessionmaker() as session:
                current = await jobs.get(session, job_id_value)
                signature = (current.status, current.progress)
                if signature != last_signature:
                    last_signature = signature
                    yield _sse("progress", to_job_response(current).model_dump(mode="json"))
                if current.status in TERMINAL_STATUSES:
                    yield _sse("done", to_job_response(current).model_dump(mode="json"))
                    return
            await asyncio.sleep(_POLL_SECONDS)
            elapsed += _POLL_SECONDS
        yield _sse("timeout", {"job_id": str(job_id_value)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
