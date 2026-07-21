"""Public, unauthenticated read access to a shared workspace.

A share token is a capability: holding the URL is the authorization. The
response carries metadata and specs only — raw uploaded rows are handed out
only when the owner enabled "share includes data", and then as short-lived
scoped download URLs.
"""

from fastapi import APIRouter

from ..core.deps import DbSession, OptionalUser, Storage, Workspaces
from ..schemas.workspace import SnapshotResponse, WorkspaceResponse
from ..services.errors import InvalidToken
from ..services.permissions import require
from .datasets import load_uploaded_dataset
from .serializers import to_snapshot_response, to_workspace_response

router = APIRouter(prefix="/shared", tags=["sharing"])


@router.get("/{share_token}", response_model=SnapshotResponse, operation_id="getSharedWorkspace")
async def get_shared(
    share_token: str,
    db: DbSession,
    service: Workspaces,
    user: OptionalUser,
) -> SnapshotResponse:
    workspace = await service.get_by_share_token(db, share_token)
    require("read", workspace, user, share_token=share_token)
    snapshot = await service.load_snapshot(db, workspace)
    await service.log(db, workspace, "view", user=user, payload={"via": "share_link"})
    return to_snapshot_response(snapshot)


@router.get(
    "/{share_token}/datasets/{dataset_id}/download",
    operation_id="getSharedDatasetDownloadUrl",
)
async def get_shared_download(
    share_token: str,
    dataset_id: str,
    db: DbSession,
    service: Workspaces,
    storage: Storage,
    user: OptionalUser,
) -> dict:
    workspace = await service.get_by_share_token(db, share_token)
    # `read_data` is only granted to a token bearer when the owner opted in.
    require("read_data", workspace, user, share_token=share_token)

    dataset = await load_uploaded_dataset(db, workspace, dataset_id)
    ttl = 300  # Short-lived: a shared link shouldn't mint durable data access.
    return {
        "download_url": storage.presign_get(dataset.storage_key or "", ttl_seconds=ttl),
        "expires_in": ttl,
    }


@router.post(
    "/{share_token}/fork",
    response_model=WorkspaceResponse,
    status_code=201,
    operation_id="forkSharedWorkspace",
)
async def fork_shared(
    share_token: str,
    db: DbSession,
    service: Workspaces,
    user: OptionalUser,
) -> WorkspaceResponse:
    workspace = await service.get_by_share_token(db, share_token)
    require("fork", workspace, user, share_token=share_token)
    if user is None:
        # Forking needs somewhere to put the copy.
        raise InvalidToken("Sign in to save a copy of this workspace")
    copy = await service.fork(db, workspace, user)
    await service.log(db, workspace, "fork", user=user, payload={"copy_id": str(copy.id)})
    return to_workspace_response(copy)
