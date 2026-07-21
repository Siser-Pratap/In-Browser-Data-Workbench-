"""Presigned direct-to-S3 uploads for opt-in raw dataset storage.

The API never proxies file bytes: it hands the client a presigned URL, the
client PUTs straight to S3/MinIO, then calls back to confirm. `boto3` is an
optional dependency — when it isn't installed or no bucket is configured, the
storage endpoints report themselves unavailable rather than breaking the app.
"""

from __future__ import annotations

import uuid
from typing import Any

from .errors import AuthError

# Extension -> the content type we sign the upload for.
ALLOWED_EXTENSIONS: dict[str, str] = {
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "json": "application/json",
    "parquet": "application/vnd.apache.parquet",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class StorageUnavailable(AuthError):
    status_code = 503
    code = "storage_unavailable"


class InvalidUpload(AuthError):
    status_code = 400
    code = "invalid_upload"


def extension_of(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


class StorageService:
    def __init__(
        self,
        *,
        bucket: str = "",
        endpoint_url: str | None = None,
        region: str = "us-east-1",
        access_key: str = "",
        secret_key: str = "",
        presign_ttl_seconds: int = 900,
        max_file_bytes: int = 2 * 1024**3,
    ) -> None:
        self.bucket = bucket
        self.endpoint_url = endpoint_url
        self.region = region
        self.access_key = access_key
        self.secret_key = secret_key
        self.presign_ttl_seconds = presign_ttl_seconds
        self.max_file_bytes = max_file_bytes
        self._client: Any | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.bucket)

    def _s3(self) -> Any:
        if not self.enabled:
            raise StorageUnavailable("Object storage is not configured")
        if self._client is None:
            try:
                import boto3
            except ImportError as exc:  # pragma: no cover - depends on env
                raise StorageUnavailable("boto3 is not installed") from exc
            self._client = boto3.client(
                "s3",
                endpoint_url=self.endpoint_url,
                region_name=self.region,
                aws_access_key_id=self.access_key or None,
                aws_secret_access_key=self.secret_key or None,
            )
        return self._client

    def validate(self, filename: str, byte_size: int) -> str:
        ext = extension_of(filename)
        if ext not in ALLOWED_EXTENSIONS:
            raise InvalidUpload(
                f"Unsupported file type '.{ext}'; allowed: "
                + ", ".join(sorted(ALLOWED_EXTENSIONS))
            )
        if byte_size <= 0 or byte_size > self.max_file_bytes:
            raise InvalidUpload(f"File exceeds the {self.max_file_bytes} byte limit")
        return ext

    def build_key(self, workspace_id: uuid.UUID, dataset_id: uuid.UUID, ext: str) -> str:
        # A random suffix so a re-upload never collides with the object a
        # still-in-flight presigned URL is writing.
        return f"workspaces/{workspace_id}/datasets/{dataset_id}/{uuid.uuid4().hex}.{ext}"

    def presign_put(self, key: str, content_type: str) -> str:
        return self._s3().generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "ContentType": content_type,
                # Encryption at rest (SSE-S3); MinIO honours the same header.
                "ServerSideEncryption": "AES256",
            },
            ExpiresIn=self.presign_ttl_seconds,
        )

    def presign_get(self, key: str, ttl_seconds: int | None = None) -> str:
        return self._s3().generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=ttl_seconds or self.presign_ttl_seconds,
        )

    def head(self, key: str) -> dict[str, Any]:
        """Size + ETag of an uploaded object, used to verify upload-complete."""
        try:
            response = self._s3().head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            raise InvalidUpload("Upload was not found in storage") from exc
        return {
            "byte_size": int(response.get("ContentLength", 0)),
            "checksum": str(response.get("ETag", "")).strip('"'),
        }

    def delete(self, key: str) -> None:
        if not self.enabled or not key:
            return
        try:
            self._s3().delete_object(Bucket=self.bucket, Key=key)
        except Exception:  # pragma: no cover - best effort; lifecycle rule backstops
            pass
