"""Request/response schemas for workspace persistence and sharing."""

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

StorageMode = Literal["local_only", "uploaded"]
MemberRole = Literal["viewer", "editor"]

# Extensions the upload flow accepts (Phase 2 scope item 3).
ALLOWED_FORMATS = ("csv", "tsv", "json", "parquet", "xlsx")


class Spec(BaseModel):
    """Envelope validation for frontend-owned spec JSON.

    The backend treats `spec`/`layout` bodies as opaque so the frontend can
    iterate on chart and layout formats without a backend migration — but the
    envelope must carry a version so old documents stay readable.
    """

    version: int
    type: str | None = None

    model_config = {"extra": "allow"}


def _validate_envelope(value: dict[str, Any] | None) -> dict[str, Any]:
    if not value:
        return {}
    Spec.model_validate(value)
    return value


# -- Workspace ---------------------------------------------------------------


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    settings: dict[str, Any] = Field(default_factory=dict)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    settings: dict[str, Any] | None = None


class WorkspaceResponse(BaseModel):
    id: str
    owner_id: str
    name: str
    description: str | None
    is_public: bool
    settings: dict[str, Any]
    created_at: dt.datetime
    updated_at: dt.datetime


class WorkspaceListResponse(BaseModel):
    items: list[WorkspaceResponse]
    total: int
    limit: int
    offset: int


# -- Nested resources --------------------------------------------------------


class DatasetIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    source_filename: str | None = Field(default=None, max_length=500)
    format: str | None = Field(default=None, max_length=20)
    dataset_schema: dict[str, Any] = Field(default_factory=dict, alias="schema")
    row_count: int | None = Field(default=None, ge=0)
    byte_size: int | None = Field(default=None, ge=0)

    model_config = {"populate_by_name": True}


class DatasetResponse(DatasetIn):
    id: str
    storage_mode: StorageMode
    created_at: dt.datetime
    updated_at: dt.datetime


class QueryIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sql: str = Field(max_length=200_000)
    position: int = 0


class QueryResponse(QueryIn):
    id: str
    created_at: dt.datetime
    updated_at: dt.datetime


class ChartIn(BaseModel):
    id: str | None = None
    query_id: str | None = None
    spec: dict[str, Any] = Field(default_factory=dict)

    @field_validator("spec")
    @classmethod
    def _spec_envelope(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _validate_envelope(v)


class ChartResponse(ChartIn):
    id: str
    created_at: dt.datetime
    updated_at: dt.datetime


class DashboardIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    layout: dict[str, Any] = Field(default_factory=dict)

    @field_validator("layout")
    @classmethod
    def _layout_envelope(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _validate_envelope(v)


class DashboardResponse(DashboardIn):
    id: str
    created_at: dt.datetime
    updated_at: dt.datetime


# -- Snapshot (the primary save path) ----------------------------------------


class SnapshotIn(BaseModel):
    """The whole workspace document, as the frontend exports it (`.dwb.json`)."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    settings: dict[str, Any] | None = None
    datasets: list[DatasetIn] = Field(default_factory=list)
    queries: list[QueryIn] = Field(default_factory=list)
    charts: list[ChartIn] = Field(default_factory=list)
    dashboards: list[DashboardIn] = Field(default_factory=list)


class SnapshotResponse(BaseModel):
    workspace: WorkspaceResponse
    datasets: list[DatasetResponse]
    queries: list[QueryResponse]
    charts: list[ChartResponse]
    dashboards: list[DashboardResponse]
    version: str


# -- Sharing -----------------------------------------------------------------


class ShareRequest(BaseModel):
    include_data: bool = False


class ShareResponse(BaseModel):
    share_token: str
    share_url: str
    include_data: bool


# -- Uploads -----------------------------------------------------------------


class UploadUrlRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=500)
    byte_size: int = Field(gt=0)
    content_type: str | None = Field(default=None, max_length=200)


class UploadUrlResponse(BaseModel):
    upload_url: str
    storage_key: str
    expires_in: int
    max_bytes: int


class UploadCompleteRequest(BaseModel):
    checksum: str | None = Field(default=None, max_length=128)
    byte_size: int | None = Field(default=None, ge=0)


class DownloadUrlResponse(BaseModel):
    download_url: str
    expires_in: int


class UsageResponse(BaseModel):
    used_bytes: int
    quota_bytes: int
    dataset_count: int
