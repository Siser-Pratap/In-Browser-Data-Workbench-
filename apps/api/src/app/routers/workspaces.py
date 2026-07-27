"""Workspace CRUD, nested resources, snapshot sync and sharing."""

from typing import Annotated

from fastapi import APIRouter, Header, Response
from fastapi import Query as QueryParam

from ..core.deps import CurrentUser, DbSession, OptionalUser, Workspaces
from ..db.models import Workspace
from ..schemas.workspace import (
    ShareRequest,
    ShareResponse,
    SnapshotIn,
    SnapshotResponse,
    WorkspaceCreate,
    WorkspaceListResponse,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from ..services.permissions import require
from ..services.workspace_service import version_of
from .serializers import to_snapshot_response, to_workspace_response

router = APIRouter(prefix="/workspaces", tags=["workspaces"])

ShareTokenHeader = Annotated[str | None, Header(alias="X-Share-Token")]


@router.post("", response_model=WorkspaceResponse, status_code=201, operation_id="createWorkspace")
async def create_workspace(
    body: WorkspaceCreate, user: CurrentUser, db: DbSession, service: Workspaces
) -> WorkspaceResponse:
    workspace = await service.create(db, user, body)
    return to_workspace_response(workspace)


@router.get("", response_model=WorkspaceListResponse, operation_id="listWorkspaces")
async def list_workspaces(
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
    limit: Annotated[int, QueryParam(ge=1, le=100)] = 50,
    offset: Annotated[int, QueryParam(ge=0)] = 0,
) -> WorkspaceListResponse:
    items, total = await service.list_for_user(db, user, limit=limit, offset=offset)
    return WorkspaceListResponse(
        items=[to_workspace_response(w) for w in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{workspace_id}", response_model=WorkspaceResponse, operation_id="getWorkspace")
async def get_workspace(
    workspace_id: str,
    db: DbSession,
    service: Workspaces,
    response: Response,
    user: OptionalUser,
    x_share_token: ShareTokenHeader = None,
) -> WorkspaceResponse:
    workspace = await service.get(db, workspace_id)
    require("read", workspace, user, share_token=x_share_token)
    response.headers["ETag"] = f'"{version_of(workspace)}"'
    return to_workspace_response(workspace)


@router.patch("/{workspace_id}", response_model=WorkspaceResponse, operation_id="updateWorkspace")
async def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdate,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
) -> WorkspaceResponse:
    workspace = await service.get(db, workspace_id)
    require("write", workspace, user)
    workspace = await service.update(db, workspace, body)
    return to_workspace_response(workspace)


@router.delete("/{workspace_id}", status_code=204, operation_id="deleteWorkspace")
async def delete_workspace(
    workspace_id: str, user: CurrentUser, db: DbSession, service: Workspaces
) -> Response:
    workspace = await service.get(db, workspace_id)
    require("delete", workspace, user)
    await service.soft_delete(db, workspace)
    return Response(status_code=204)


# -- snapshot: the primary save path -----------------------------------------


@router.get(
    "/{workspace_id}/snapshot", response_model=SnapshotResponse, operation_id="getWorkspaceSnapshot"
)
async def get_snapshot(
    workspace_id: str,
    db: DbSession,
    service: Workspaces,
    response: Response,
    user: OptionalUser,
    x_share_token: ShareTokenHeader = None,
) -> SnapshotResponse:
    workspace = await service.get(db, workspace_id)
    require("read", workspace, user, share_token=x_share_token)
    snapshot = await service.load_snapshot(db, workspace)
    response.headers["ETag"] = f'"{version_of(workspace)}"'
    return to_snapshot_response(snapshot)


@router.put(
    "/{workspace_id}/snapshot",
    response_model=SnapshotResponse,
    operation_id="saveWorkspaceSnapshot",
)
async def save_snapshot(
    workspace_id: str,
    body: SnapshotIn,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
    response: Response,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> SnapshotResponse:
    """Upsert the whole workspace document atomically.

    Pass the ETag from a previous GET as `If-Match` for optimistic concurrency;
    a divergent server version returns 409 so the client can prompt.
    """
    workspace = await service.get(db, workspace_id)
    require("write", workspace, user)
    snapshot = await service.save_snapshot(db, workspace, body, if_match=if_match)
    response.headers["ETag"] = f'"{version_of(workspace)}"'
    return to_snapshot_response(snapshot)


# -- sharing -----------------------------------------------------------------


@router.post("/{workspace_id}/share", response_model=ShareResponse, operation_id="shareWorkspace")
async def share_workspace(
    workspace_id: str,
    body: ShareRequest,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
) -> ShareResponse:
    workspace = await service.get(db, workspace_id)
    require("share", workspace, user)
    workspace = await service.share(db, workspace, include_data=body.include_data)
    await service.log(
        db, workspace, "share", user=user, payload={"include_data": body.include_data}
    )
    return ShareResponse(
        share_token=workspace.share_token or "",
        share_url=service.share_url(workspace),
        include_data=workspace.share_includes_data,
    )


@router.delete("/{workspace_id}/share", status_code=204, operation_id="unshareWorkspace")
async def unshare_workspace(
    workspace_id: str, user: CurrentUser, db: DbSession, service: Workspaces
) -> Response:
    workspace = await service.get(db, workspace_id)
    require("share", workspace, user)
    await service.unshare(db, workspace)
    await service.log(db, workspace, "unshare", user=user)
    return Response(status_code=204)


@router.post(
    "/{workspace_id}/fork",
    response_model=WorkspaceResponse,
    status_code=201,
    operation_id="forkWorkspace",
)
async def fork_workspace(
    workspace_id: str,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
    x_share_token: ShareTokenHeader = None,
) -> WorkspaceResponse:
    source: Workspace = await service.get(db, workspace_id)
    require("fork", source, user, share_token=x_share_token)
    copy = await service.fork(db, source, user)
    await service.log(db, source, "fork", user=user, payload={"copy_id": str(copy.id)})
    return to_workspace_response(copy)
