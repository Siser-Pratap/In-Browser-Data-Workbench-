"""ORM row -> response schema conversions for the workspace routers."""

from typing import Any

from ..db.models import Chart, Dashboard, Dataset, Query, Workspace
from ..schemas.workspace import (
    ChartResponse,
    DashboardResponse,
    DatasetResponse,
    QueryResponse,
    SnapshotResponse,
    WorkspaceResponse,
)
from ..services.workspace_service import version_of


def to_workspace_response(w: Workspace) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=str(w.id),
        owner_id=str(w.owner_id),
        name=w.name,
        description=w.description,
        is_public=w.is_public,
        settings=w.settings or {},
        created_at=w.created_at,
        updated_at=w.updated_at,
    )


def to_dataset_response(d: Dataset) -> DatasetResponse:
    return DatasetResponse(
        id=str(d.id),
        name=d.name,
        source_filename=d.source_filename,
        format=d.format,
        schema=d.schema_json or {},
        row_count=d.row_count,
        byte_size=d.byte_size,
        storage_mode=d.storage_mode,  # type: ignore[arg-type]
        created_at=d.created_at,
        updated_at=d.updated_at,
    )


def to_query_response(q: Query) -> QueryResponse:
    return QueryResponse(
        id=str(q.id),
        name=q.name,
        sql=q.sql,
        position=q.position,
        created_at=q.created_at,
        updated_at=q.updated_at,
    )


def to_chart_response(c: Chart) -> ChartResponse:
    return ChartResponse(
        id=str(c.id),
        query_id=str(c.query_id) if c.query_id else None,
        spec=c.spec or {},
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


def to_dashboard_response(d: Dashboard) -> DashboardResponse:
    return DashboardResponse(
        id=str(d.id),
        name=d.name,
        layout=d.layout or {},
        created_at=d.created_at,
        updated_at=d.updated_at,
    )


def to_snapshot_response(snapshot: dict[str, Any]) -> SnapshotResponse:
    workspace: Workspace = snapshot["workspace"]
    return SnapshotResponse(
        workspace=to_workspace_response(workspace),
        datasets=[to_dataset_response(d) for d in snapshot["datasets"]],
        queries=[to_query_response(q) for q in snapshot["queries"]],
        charts=[to_chart_response(c) for c in snapshot["charts"]],
        dashboards=[to_dashboard_response(d) for d in snapshot["dashboards"]],
        version=version_of(workspace),
    )
