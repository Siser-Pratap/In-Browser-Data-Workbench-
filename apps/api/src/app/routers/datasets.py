"""Opt-in raw file storage for datasets.

Flow: `POST upload-url` (quota + type checked, key reserved) -> client PUTs the
bytes straight to S3/MinIO -> `POST upload-complete` verifies what actually
landed and flips `storage_mode` to `uploaded`. The API never sees the bytes.
"""

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.deps import CurrentUser, DbSession, Storage, Workspaces
from ..db.models import Dataset, Workspace
from ..schemas.workspace import (
    DatasetResponse,
    DownloadUrlResponse,
    UploadCompleteRequest,
    UploadUrlRequest,
    UploadUrlResponse,
    UsageResponse,
)
from ..services.permissions import NotVisible, require
from ..services.storage_service import ALLOWED_EXTENSIONS, InvalidUpload
from ..services.workspace_service import touch
from .serializers import to_dataset_response

router = APIRouter(tags=["storage"])


async def load_dataset(db: AsyncSession, workspace: Workspace, dataset_id: str) -> Dataset:
    import uuid

    try:
        did = uuid.UUID(dataset_id)
    except (ValueError, TypeError) as exc:
        raise NotVisible("Dataset not found") from exc
    row = (
        await db.execute(
            select(Dataset).where(Dataset.id == did, Dataset.workspace_id == workspace.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotVisible("Dataset not found")
    return row


async def load_uploaded_dataset(
    db: AsyncSession, workspace: Workspace, dataset_id: str
) -> Dataset:
    dataset = await load_dataset(db, workspace, dataset_id)
    if dataset.storage_mode != "uploaded" or not dataset.storage_key:
        raise InvalidUpload("This dataset has no uploaded file")
    return dataset


@router.post(
    "/workspaces/{workspace_id}/datasets/{dataset_id}/upload-url",
    response_model=UploadUrlResponse,
    operation_id="createDatasetUploadUrl",
)
async def create_upload_url(
    workspace_id: str,
    dataset_id: str,
    body: UploadUrlRequest,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
    storage: Storage,
) -> UploadUrlResponse:
    workspace = await service.get(db, workspace_id)
    require("write", workspace, user)
    dataset = await load_dataset(db, workspace, dataset_id)

    ext = storage.validate(body.filename, body.byte_size)
    await service.check_quota(db, user, body.byte_size)

    key = storage.build_key(workspace.id, dataset.id, ext)
    url = storage.presign_put(key, body.content_type or ALLOWED_EXTENSIONS[ext])

    # Re-uploading replaces the file: drop the object the dataset used to point
    # at, or it lingers in the bucket with nothing referencing it.
    if dataset.storage_key and dataset.storage_key != key:
        storage.delete(dataset.storage_key)

    # Recorded now so upload-complete knows which object to verify; the dataset
    # stays `local_only` until the bytes are confirmed to have landed.
    dataset.storage_key = key
    dataset.source_filename = body.filename
    dataset.format = ext
    await db.commit()

    return UploadUrlResponse(
        upload_url=url,
        storage_key=key,
        expires_in=storage.presign_ttl_seconds,
        max_bytes=storage.max_file_bytes,
    )


@router.post(
    "/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
    response_model=DatasetResponse,
    operation_id="completeDatasetUpload",
)
async def complete_upload(
    workspace_id: str,
    dataset_id: str,
    body: UploadCompleteRequest,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
    storage: Storage,
) -> DatasetResponse:
    workspace = await service.get(db, workspace_id)
    require("write", workspace, user)
    dataset = await load_dataset(db, workspace, dataset_id)
    if not dataset.storage_key:
        raise InvalidUpload("No upload was started for this dataset")

    # Trust the object store, not the client, for what actually landed.
    actual = storage.head(dataset.storage_key)
    if body.checksum and actual["checksum"] and body.checksum != actual["checksum"]:
        storage.delete(dataset.storage_key)
        dataset.storage_key = None
        await db.commit()
        raise InvalidUpload("Checksum mismatch; the upload was discarded")

    await service.check_quota(db, user, actual["byte_size"])

    dataset.byte_size = actual["byte_size"]
    dataset.checksum = actual["checksum"]
    dataset.storage_mode = "uploaded"
    touch(workspace)
    await db.commit()
    await db.refresh(dataset)
    return to_dataset_response(dataset)


@router.get(
    "/workspaces/{workspace_id}/datasets/{dataset_id}/download-url",
    response_model=DownloadUrlResponse,
    operation_id="getDatasetDownloadUrl",
)
async def get_download_url(
    workspace_id: str,
    dataset_id: str,
    user: CurrentUser,
    db: DbSession,
    service: Workspaces,
    storage: Storage,
) -> DownloadUrlResponse:
    """Re-attach uploaded data on another machine."""
    workspace = await service.get(db, workspace_id)
    require("read_data", workspace, user)
    dataset = await load_uploaded_dataset(db, workspace, dataset_id)
    return DownloadUrlResponse(
        download_url=storage.presign_get(dataset.storage_key or ""),
        expires_in=storage.presign_ttl_seconds,
    )


@router.get("/users/me/usage", response_model=UsageResponse, operation_id="getStorageUsage")
async def get_usage(user: CurrentUser, db: DbSession, service: Workspaces) -> UsageResponse:
    used, count = await service.used_bytes(db, user)
    return UsageResponse(
        used_bytes=used, quota_bytes=service.storage_quota_bytes, dataset_count=count
    )
