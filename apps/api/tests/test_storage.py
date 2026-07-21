"""Presigned upload flow, quota and checksum verification.

`boto3` is never exercised: the S3 client is replaced with a fake that records
what was asked of it. What matters here is the API's own logic — allowlist,
quota, and trusting the object store over the client at upload-complete.
"""

import re

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.storage_service import InvalidUpload, StorageService

from .test_workspaces import SNAPSHOT, auth, create_workspace, register  # noqa: F401


class FakeS3:
    """Stands in for the boto3 S3 client."""

    def __init__(self) -> None:
        self.objects: dict[str, dict] = {}
        self.deleted: list[str] = []

    def generate_presigned_url(self, operation, Params, ExpiresIn):  # noqa: N803
        return f"https://fake-s3.test/{Params['Key']}?op={operation}&exp={ExpiresIn}"

    def head_object(self, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise KeyError(Key)
        return self.objects[Key]

    def delete_object(self, Bucket, Key):  # noqa: N803
        self.deleted.append(Key)
        self.objects.pop(Key, None)

    def put(self, key: str, byte_size: int, etag: str = "abc123") -> None:
        self.objects[key] = {"ContentLength": byte_size, "ETag": f'"{etag}"'}


@pytest.fixture
def app_settings() -> Settings:
    return Settings(
        anthropic_api_key="test-key",
        database_url="sqlite+aiosqlite:///:memory:",
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        s3_bucket="workbench-test",
        storage_quota_bytes=10_000,
        storage_max_file_bytes=5_000,
        _env_file=None,
    )


@pytest.fixture
def fake_s3() -> FakeS3:
    return FakeS3()


@pytest.fixture
def client(app_settings, fake_s3):
    app = create_app(app_settings)
    app.state.storage_service._client = fake_s3
    with TestClient(app) as c:
        yield c


@pytest.fixture
def dataset(client):
    """A workspace with one dataset; returns (token, workspace_id, dataset_id)."""
    token = register(client)
    workspace = create_workspace(client, token)
    client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot", json=SNAPSHOT, headers=auth(token)
    )
    return token, workspace["id"], SNAPSHOT["datasets"][0]["id"]


def upload_url(client, token, workspace_id, dataset_id, **body):
    payload = {"filename": "orders.csv", "byte_size": 1024, **body}
    return client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-url",
        json=payload,
        headers=auth(token),
    )


# -- validation ---------------------------------------------------------------


def test_extension_allowlist():
    storage = StorageService(bucket="b")
    for ext in ("csv", "tsv", "json", "parquet", "xlsx"):
        assert storage.validate(f"data.{ext}", 10) == ext
    for bad in ("data.exe", "data.sql", "data"):
        with pytest.raises(InvalidUpload):
            storage.validate(bad, 10)


def test_max_file_size_is_enforced():
    storage = StorageService(bucket="b", max_file_bytes=100)
    with pytest.raises(InvalidUpload):
        storage.validate("data.csv", 101)


def test_upload_url_rejects_a_disallowed_extension(client, dataset):
    token, workspace_id, dataset_id = dataset
    resp = upload_url(client, token, workspace_id, dataset_id, filename="payload.exe")
    assert resp.status_code == 400
    assert resp.json()["code"] == "invalid_upload"


# -- the happy path -----------------------------------------------------------


def test_upload_flow_end_to_end(client, dataset, fake_s3):
    token, workspace_id, dataset_id = dataset

    started = upload_url(client, token, workspace_id, dataset_id, byte_size=2048)
    assert started.status_code == 200, started.text
    key = started.json()["storage_key"]
    assert key.startswith(f"workspaces/{workspace_id}/datasets/{dataset_id}/")
    assert "op=put_object" in started.json()["upload_url"]

    # The client PUTs the bytes directly; the API never sees them.
    fake_s3.put(key, byte_size=2048, etag="deadbeef")

    completed = client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={"checksum": "deadbeef"},
        headers=auth(token),
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["storage_mode"] == "uploaded"
    assert completed.json()["byte_size"] == 2048

    usage = client.get("/api/v1/users/me/usage", headers=auth(token)).json()
    assert usage["used_bytes"] == 2048
    assert usage["dataset_count"] == 1

    download = client.get(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/download-url",
        headers=auth(token),
    )
    assert download.status_code == 200
    assert "op=get_object" in download.json()["download_url"]


def test_size_is_taken_from_storage_not_the_client(client, dataset, fake_s3):
    token, workspace_id, dataset_id = dataset
    key = upload_url(client, token, workspace_id, dataset_id, byte_size=100).json()["storage_key"]
    # The client claimed 100 bytes; 3000 actually landed.
    fake_s3.put(key, byte_size=3000)

    completed = client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )
    assert completed.json()["byte_size"] == 3000


def test_checksum_mismatch_is_rejected_and_the_object_deleted(client, dataset, fake_s3):
    token, workspace_id, dataset_id = dataset
    key = upload_url(client, token, workspace_id, dataset_id).json()["storage_key"]
    fake_s3.put(key, byte_size=1024, etag="actual")

    resp = client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={"checksum": "what-the-client-expected"},
        headers=auth(token),
    )
    assert resp.status_code == 400
    assert key in fake_s3.deleted

    usage = client.get("/api/v1/users/me/usage", headers=auth(token)).json()
    assert usage["used_bytes"] == 0


def test_upload_complete_without_a_started_upload(client, dataset):
    token, workspace_id, dataset_id = dataset
    resp = client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )
    assert resp.status_code == 400


def test_missing_object_at_complete_is_rejected(client, dataset):
    token, workspace_id, dataset_id = dataset
    upload_url(client, token, workspace_id, dataset_id)
    # Nothing was ever PUT to the fake store.
    resp = client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )
    assert resp.status_code == 400


# -- quota --------------------------------------------------------------------


def test_quota_is_enforced_at_upload_url_time(client, dataset, fake_s3):
    token, workspace_id, first_id = dataset

    def add_dataset(name: str) -> str:
        return client.post(
            f"/api/v1/workspaces/{workspace_id}/datasets",
            json={"name": name},
            headers=auth(token),
        ).json()["id"]

    def upload(dataset_id: str, size: int):
        started = upload_url(client, token, workspace_id, dataset_id, byte_size=size)
        if started.status_code != 200:
            return started
        fake_s3.put(started.json()["storage_key"], byte_size=size)
        return client.post(
            f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
            json={},
            headers=auth(token),
        )

    # Quota 10000, per-file cap 5000: two 4000-byte files fit, a third does not.
    assert upload(first_id, 4000).status_code == 200
    assert upload(add_dataset("second"), 4000).status_code == 200

    third = upload(add_dataset("third"), 4000)
    assert third.status_code == 413
    assert third.json()["code"] == "quota_exceeded"


def test_reuploading_deletes_the_previous_object(client, dataset, fake_s3):
    token, workspace_id, dataset_id = dataset
    first_key = upload_url(client, token, workspace_id, dataset_id).json()["storage_key"]
    fake_s3.put(first_key, byte_size=1024)
    client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )

    second_key = upload_url(client, token, workspace_id, dataset_id).json()["storage_key"]
    assert second_key != first_key
    assert first_key in fake_s3.deleted


# -- authorization ------------------------------------------------------------


def test_stranger_cannot_start_an_upload(client, dataset):
    _, workspace_id, dataset_id = dataset
    stranger = register(client, "stranger@example.com")
    assert upload_url(client, stranger, workspace_id, dataset_id).status_code == 404


def test_share_link_data_access_follows_the_owners_opt_in(client, dataset, fake_s3):
    token, workspace_id, dataset_id = dataset
    key = upload_url(client, token, workspace_id, dataset_id).json()["storage_key"]
    fake_s3.put(key, byte_size=1024)
    client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )

    # Shared without data: metadata is public, the rows are not.
    share_token = client.post(
        f"/api/v1/workspaces/{workspace_id}/share",
        json={"include_data": False},
        headers=auth(token),
    ).json()["share_token"]
    assert client.get(f"/api/v1/shared/{share_token}").status_code == 200
    denied = client.get(f"/api/v1/shared/{share_token}/datasets/{dataset_id}/download")
    assert denied.status_code == 403

    # Re-shared with data: now the link mints a short-lived download URL.
    share_token = client.post(
        f"/api/v1/workspaces/{workspace_id}/share",
        json={"include_data": True},
        headers=auth(token),
    ).json()["share_token"]
    allowed = client.get(f"/api/v1/shared/{share_token}/datasets/{dataset_id}/download")
    assert allowed.status_code == 200
    assert allowed.json()["expires_in"] == 300
    assert re.search(r"exp=300", allowed.json()["download_url"])


def test_fork_does_not_copy_uploaded_files(client, dataset, fake_s3):
    token, workspace_id, dataset_id = dataset
    key = upload_url(client, token, workspace_id, dataset_id).json()["storage_key"]
    fake_s3.put(key, byte_size=1024)
    client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )
    share_token = client.post(
        f"/api/v1/workspaces/{workspace_id}/share", json={}, headers=auth(token)
    ).json()["share_token"]

    visitor = register(client, "visitor@example.com")
    copy = client.post(f"/api/v1/shared/{share_token}/fork", headers=auth(visitor)).json()

    snapshot = client.get(
        f"/api/v1/workspaces/{copy['id']}/snapshot", headers=auth(visitor)
    ).json()
    assert snapshot["datasets"][0]["storage_mode"] == "local_only"
    # And the copy doesn't count against the visitor's quota.
    assert client.get("/api/v1/users/me/usage", headers=auth(visitor)).json()["used_bytes"] == 0


def test_snapshot_save_never_drops_an_uploaded_dataset(client, dataset, fake_s3):
    """A client that never saw the upload must not orphan the S3 object."""
    token, workspace_id, dataset_id = dataset
    key = upload_url(client, token, workspace_id, dataset_id).json()["storage_key"]
    fake_s3.put(key, byte_size=1024)
    client.post(
        f"/api/v1/workspaces/{workspace_id}/datasets/{dataset_id}/upload-complete",
        json={},
        headers=auth(token),
    )

    stale = {**SNAPSHOT, "datasets": []}
    body = client.put(
        f"/api/v1/workspaces/{workspace_id}/snapshot", json=stale, headers=auth(token)
    ).json()
    assert [d["id"] for d in body["datasets"]] == [dataset_id]
