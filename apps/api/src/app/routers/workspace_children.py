"""Granular CRUD for the resources nested under a workspace.

The snapshot endpoint is the primary save path; these serve targeted edits
(rename a query, tweak one chart) without round-tripping the whole document.
Each resource is the same four operations over a different model, so they're
generated from one table rather than written out four times.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Header, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.deps import CurrentUser, DbSession, OptionalUser, Workspaces
from ..db.models import Chart, Dashboard, Dataset, Query, Workspace
from ..schemas.workspace import (
    ChartIn,
    ChartResponse,
    DashboardIn,
    DashboardResponse,
    DatasetIn,
    DatasetResponse,
    QueryIn,
    QueryResponse,
)
from ..services.permissions import NotVisible, require
from ..services.workspace_service import touch
from .serializers import (
    to_chart_response,
    to_dashboard_response,
    to_dataset_response,
    to_query_response,
)

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["workspaces"])

ShareTokenHeader = Annotated[str | None, Header(alias="X-Share-Token")]


def _apply_dataset(row: Dataset, body: DatasetIn) -> None:
    row.name = body.name
    row.source_filename = body.source_filename
    row.format = body.format
    row.schema_json = body.dataset_schema
    row.row_count = body.row_count
    row.byte_size = body.byte_size


def _apply_query(row: Query, body: QueryIn) -> None:
    row.name = body.name
    row.sql = body.sql
    row.position = body.position


def _apply_chart(row: Chart, body: ChartIn) -> None:
    row.spec = body.spec
    row.query_id = _as_uuid(body.query_id)


def _apply_dashboard(row: Dashboard, body: DashboardIn) -> None:
    row.name = body.name
    row.layout = body.layout


def _as_uuid(value: str | None):
    import uuid

    if not value:
        return None
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


async def _child(db: AsyncSession, model, workspace: Workspace, child_id: str):
    cid = _as_uuid(child_id)
    if cid is None:
        raise NotVisible("Resource not found")
    row = (
        await db.execute(
            select(model).where(model.id == cid, model.workspace_id == workspace.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotVisible("Resource not found")
    return row


async def _load(db: AsyncSession, model, workspace: Workspace) -> list[Any]:
    return list(
        (await db.execute(select(model).where(model.workspace_id == workspace.id))).scalars()
    )


def _register(path: str, model, schema_in, response_model, apply, serialize, name: str) -> None:
    """Mount list/create/update/delete for one nested resource."""

    @router.get(
        f"/{path}",
        response_model=list[response_model],
        operation_id=f"list{name}s",
        name=f"list_{path}",
    )
    async def _list(
        workspace_id: str,
        db: DbSession,
        service: Workspaces,
        user: OptionalUser,
        x_share_token: ShareTokenHeader = None,
    ):
        workspace = await service.get(db, workspace_id)
        require("read", workspace, user, share_token=x_share_token)
        return [serialize(row) for row in await _load(db, model, workspace)]

    @router.post(
        f"/{path}",
        response_model=response_model,
        status_code=201,
        operation_id=f"create{name}",
        name=f"create_{path}",
    )
    async def _create(
        workspace_id: str,
        body: schema_in,  # type: ignore[valid-type]
        user: CurrentUser,
        db: DbSession,
        service: Workspaces,
    ):
        workspace = await service.get(db, workspace_id)
        require("write", workspace, user)
        row = model(workspace_id=workspace.id)
        apply(row, body)
        db.add(row)
        touch(workspace)
        await db.commit()
        await db.refresh(row)
        return serialize(row)

    @router.patch(
        f"/{path}/{{child_id}}",
        response_model=response_model,
        operation_id=f"update{name}",
        name=f"update_{path}",
    )
    async def _update(
        workspace_id: str,
        child_id: str,
        body: schema_in,  # type: ignore[valid-type]
        user: CurrentUser,
        db: DbSession,
        service: Workspaces,
    ):
        workspace = await service.get(db, workspace_id)
        require("write", workspace, user)
        row = await _child(db, model, workspace, child_id)
        apply(row, body)
        touch(workspace)
        await db.commit()
        await db.refresh(row)
        return serialize(row)

    @router.delete(
        f"/{path}/{{child_id}}",
        status_code=204,
        operation_id=f"delete{name}",
        name=f"delete_{path}",
    )
    async def _delete(
        workspace_id: str,
        child_id: str,
        user: CurrentUser,
        db: DbSession,
        service: Workspaces,
    ):
        workspace = await service.get(db, workspace_id)
        require("write", workspace, user)
        row = await _child(db, model, workspace, child_id)
        await db.delete(row)
        touch(workspace)
        await db.commit()
        return Response(status_code=204)


_register(
    "datasets", Dataset, DatasetIn, DatasetResponse, _apply_dataset, to_dataset_response, "Dataset"
)
_register("queries", Query, QueryIn, QueryResponse, _apply_query, to_query_response, "Query")
_register("charts", Chart, ChartIn, ChartResponse, _apply_chart, to_chart_response, "Chart")
_register(
    "dashboards",
    Dashboard,
    DashboardIn,
    DashboardResponse,
    _apply_dashboard,
    to_dashboard_response,
    "Dashboard",
)
