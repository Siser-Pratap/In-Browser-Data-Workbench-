"""Request/response schemas for jobs and server-side compute."""

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, Field

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class ComputeQueryRequest(BaseModel):
    workspace_id: str
    dataset_ids: list[str] = Field(min_length=1, max_length=20)
    sql: str = Field(min_length=1, max_length=200_000)


class JobResponse(BaseModel):
    id: str
    kind: str
    status: JobStatus
    progress: int
    workspace_id: str | None
    result: dict[str, Any]
    error: str | None
    attempts: int
    max_attempts: int
    created_at: dt.datetime
    started_at: dt.datetime | None
    finished_at: dt.datetime | None


class JobListResponse(BaseModel):
    items: list[JobResponse]
    total: int
    limit: int
    offset: int


class JobAcceptedResponse(BaseModel):
    job_id: str
    status: JobStatus


class ComputeResultResponse(BaseModel):
    """Where to fetch the Arrow IPC bytes, plus what they contain."""

    download_url: str
    expires_in: int
    row_count: int
    columns: list[str]
    truncated: bool
    byte_size: int
    executed_sql: str
