"""Server compute end to end, and the maintenance jobs.

The compute job reads a local file rather than S3 — `StorageService.s3_url` is
stubbed to return a path, so the whole request → job → result → download chain
runs without MinIO while exercising the real code.
"""

import csv

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.workers.runner import execute_job
from app.workers.worker import build_deps

from .test_storage import FakeS3
from .test_workspaces import auth, create_workspace, register


@pytest.fixture
def orders_csv(tmp_path):
    path = tmp_path / "orders.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "region", "amount"])
        for i in range(500):
            writer.writerow([i, "north" if i % 2 else "south", i * 3])
    return str(path)


@pytest.fixture
def app_settings() -> Settings:
    return Settings(
        anthropic_api_key="test-key",
        database_url="sqlite+aiosqlite:///:memory:",
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        s3_bucket="workbench-test",
        redis_url="",
        _env_file=None,
    )


@pytest.fixture
def fake_s3() -> FakeS3:
    return FakeS3()


class ManualQueue:
    """Records what was enqueued instead of running it.

    `TestClient` drives the app on its own event loop, so jobs started by the
    default inline queue would land on a different loop than the async test —
    nothing could await them deterministically. Holding the ids and running them
    from the test's own loop keeps the assertions honest and ordered.
    (`InlineQueue` itself is covered directly in test_jobs.py.)
    """

    def __init__(self):
        self.enqueued: list[str] = []

    async def enqueue(self, job_id, *, delay_seconds: int = 0):
        self.enqueued.append(str(job_id))

    async def close(self):
        pass


@pytest.fixture
def client(app_settings, fake_s3, orders_csv, monkeypatch):
    app = create_app(app_settings)
    app.state.storage_service._client = fake_s3
    # The engine reads whatever `s3_url` returns; point it at the fixture file.
    monkeypatch.setattr(
        type(app.state.storage_service), "s3_url", lambda self, key: orders_csv
    )
    with TestClient(app) as c:
        c.app.state.job_queue = ManualQueue()
        yield c


@pytest.fixture
def deps(client, app_settings):
    """The same services the API holds, so the fake S3 client applies.

    Row cap is low so truncation is reachable without a million-row fixture.
    """
    deps = build_deps(
        app_settings,
        storage=client.app.state.storage_service,
        jobs=client.app.state.job_service,
    )
    deps.engine.max_rows = 100
    deps.engine.timeout_seconds = 15
    return deps


async def run_pending(client, deps):
    """Run whatever the request enqueued, on the test's own loop."""
    statuses = []
    for job_id in client.app.state.job_queue.enqueued:
        statuses.append(await execute_job(client.app.state.db.sessionmaker, job_id, deps))
    client.app.state.job_queue.enqueued.clear()
    return statuses


@pytest.fixture
def uploaded(client, fake_s3):
    """A workspace with one *uploaded* csv dataset. Returns (token, ws_id, ds_id)."""
    token = register(client)
    workspace = create_workspace(client, token)
    created = client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets",
        json={"name": "orders"},
        headers=auth(token),
    ).json()

    started = client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets/{created['id']}/upload-url",
        json={"filename": "orders.csv", "byte_size": 4096},
        headers=auth(token),
    ).json()
    fake_s3.put(started["storage_key"], byte_size=4096)
    client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets/{created['id']}/upload-complete",
        json={},
        headers=auth(token),
    )
    return token, workspace["id"], created["id"]


def submit(client, token, workspace_id, dataset_ids, sql):
    return client.post(
        "/api/v1/compute/queries",
        json={"workspace_id": workspace_id, "dataset_ids": dataset_ids, "sql": sql},
        headers=auth(token),
    )


# -- the happy path -----------------------------------------------------------


async def test_compute_query_end_to_end(client, uploaded, deps):
    token, workspace_id, dataset_id = uploaded

    accepted = submit(
        client, token, workspace_id, [dataset_id],
        "SELECT region, count(*) AS c FROM orders GROUP BY region ORDER BY region",
    )
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    assert accepted.json()["status"] == "queued"

    assert await run_pending(client, deps) == ["succeeded"]

    status = client.get(f"/api/v1/compute/queries/{job_id}", headers=auth(token)).json()
    assert status["status"] == "succeeded"
    assert status["result"]["row_count"] == 2

    result = client.get(f"/api/v1/compute/queries/{job_id}/result", headers=auth(token))
    assert result.status_code == 200
    body = result.json()
    assert body["row_count"] == 2
    assert body["columns"] == ["region", "c"]
    assert body["truncated"] is False
    assert "op=get_object" in body["download_url"]

    # The Arrow bytes really landed in storage and really parse.
    import io

    import pyarrow as pa

    key = body["download_url"].split("?")[0].split("/", 3)[-1]
    stored = client.app.state.storage_service._client.bodies[key]
    table = pa.ipc.open_stream(io.BytesIO(stored)).read_all()
    assert table.num_rows == 2


async def test_large_result_is_capped_and_flagged(client, uploaded, deps):
    token, workspace_id, dataset_id = uploaded
    job_id = submit(
        client, token, workspace_id, [dataset_id], "SELECT * FROM orders"
    ).json()["job_id"]

    await run_pending(client, deps)
    body = client.get(f"/api/v1/compute/queries/{job_id}/result", headers=auth(token)).json()
    assert body["row_count"] == 100  # max_rows
    assert body["truncated"] is True


# -- rejection happens up front -----------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv('/etc/passwd')",
        "DROP TABLE orders",
        "SELECT * FROM orders; DROP TABLE orders",
        "COPY orders TO '/tmp/exfil.csv'",
    ],
)
def test_dangerous_sql_is_refused_synchronously(client, uploaded, sql):
    """No job is created — the user gets the error on the POST, not later."""
    token, workspace_id, dataset_id = uploaded
    response = submit(client, token, workspace_id, [dataset_id], sql)
    assert response.status_code == 400
    assert response.json()["code"] == "sql_rejected"
    assert client.get("/api/v1/jobs", headers=auth(token)).json()["total"] == 0


def test_local_only_datasets_are_refused(client):
    token = register(client)
    workspace = create_workspace(client, token)
    dataset = client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets",
        json={"name": "orders"},
        headers=auth(token),
    ).json()

    response = submit(client, token, workspace["id"], [dataset["id"]], "SELECT * FROM orders")
    assert response.status_code == 400
    assert "local-only" in response.json()["detail"]


def test_another_users_workspace_is_a_404(client, uploaded):
    _, workspace_id, dataset_id = uploaded
    stranger = register(client, "stranger@example.com")
    assert submit(
        client, stranger, workspace_id, [dataset_id], "SELECT * FROM orders"
    ).status_code == 404


def test_a_dataset_from_another_workspace_is_refused(client, uploaded):
    """Cross-tenant dataset ids must not be bindable into someone else's query."""
    token, workspace_id, dataset_id = uploaded
    other = create_workspace(client, token, name="Other")
    response = submit(client, token, other["id"], [dataset_id], "SELECT * FROM orders")
    assert response.status_code == 400


def test_result_before_completion_is_refused(client, uploaded):
    token, workspace_id, dataset_id = uploaded
    job_id = submit(
        client, token, workspace_id, [dataset_id], "SELECT * FROM orders"
    ).json()["job_id"]
    response = client.get(f"/api/v1/compute/queries/{job_id}/result", headers=auth(token))
    assert response.status_code == 400


# -- maintenance jobs ---------------------------------------------------------


async def test_purge_removes_expired_workspaces_and_their_files(client, uploaded, deps, fake_s3):
    import datetime as dt

    from sqlalchemy import select

    from app.db.models import Job, Workspace
    from app.workers.tasks import RETENTION_DAYS

    token, workspace_id, _ = uploaded
    client.delete(f"/api/v1/workspaces/{workspace_id}", headers=auth(token))

    sessionmaker = client.app.state.db.sessionmaker
    async with sessionmaker() as db:
        workspace = (
            await db.execute(select(Workspace).where(Workspace.id == _uuid(workspace_id)))
        ).scalar_one()
        # Backdate past the retention window.
        workspace.deleted_at = dt.datetime.now(dt.UTC) - dt.timedelta(days=RETENTION_DAYS + 1)
        await db.commit()

        job = await deps.jobs.create(db, kind="purge_soft_deleted", max_attempts=1)
        job_id = job.id

    assert await execute_job(sessionmaker, job_id, deps) == "succeeded"

    async with sessionmaker() as db:
        assert (
            await db.execute(select(Workspace).where(Workspace.id == _uuid(workspace_id)))
        ).scalar_one_or_none() is None
        done = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one()
        assert done.result["workspaces_purged"] == 1
        assert done.result["objects_deleted"] == 1
    assert fake_s3.deleted, "the uploaded object should have been removed"


async def test_purge_leaves_workspaces_inside_the_retention_window(client, uploaded, deps):
    from sqlalchemy import select

    from app.db.models import Workspace

    token, workspace_id, _ = uploaded
    client.delete(f"/api/v1/workspaces/{workspace_id}", headers=auth(token))

    sessionmaker = client.app.state.db.sessionmaker
    async with sessionmaker() as db:
        job = await deps.jobs.create(db, kind="purge_soft_deleted", max_attempts=1)
        job_id = job.id
    await execute_job(sessionmaker, job_id, deps)

    async with sessionmaker() as db:
        assert (
            await db.execute(select(Workspace).where(Workspace.id == _uuid(workspace_id)))
        ).scalar_one_or_none() is not None


async def test_orphaned_upload_references_are_cleaned(client, deps, fake_s3):
    """A reserved key whose upload never completed shouldn't linger forever."""
    import datetime as dt

    from sqlalchemy import select

    from app.db.models import Dataset
    from app.workers.tasks import ORPHAN_UPLOAD_HOURS

    token = register(client)
    workspace = create_workspace(client, token)
    dataset = client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets",
        json={"name": "orders"},
        headers=auth(token),
    ).json()
    client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets/{dataset['id']}/upload-url",
        json={"filename": "orders.csv", "byte_size": 1024},
        headers=auth(token),
    )
    # ...and the client vanishes without ever calling upload-complete.

    sessionmaker = client.app.state.db.sessionmaker
    async with sessionmaker() as db:
        row = (
            await db.execute(select(Dataset).where(Dataset.id == _uuid(dataset["id"])))
        ).scalar_one()
        assert row.storage_key is not None
        row.updated_at = dt.datetime.now(dt.UTC) - dt.timedelta(hours=ORPHAN_UPLOAD_HOURS + 1)
        await db.commit()

        job = await deps.jobs.create(db, kind="cleanup_orphaned_uploads", max_attempts=1)
        job_id = job.id

    assert await execute_job(sessionmaker, job_id, deps) == "succeeded"

    async with sessionmaker() as db:
        row = (
            await db.execute(select(Dataset).where(Dataset.id == _uuid(dataset["id"])))
        ).scalar_one()
        assert row.storage_key is None


async def test_account_deletion_purges_stored_files(client, uploaded, fake_s3):
    """The data-retention promise: deleting an account removes the S3 objects,
    not just the rows that reference them."""
    token, _, _ = uploaded
    assert not fake_s3.deleted

    response = client.delete("/api/v1/users/me", headers=auth(token))
    assert response.status_code == 200
    assert len(fake_s3.deleted) == 1


def _uuid(value: str):
    import uuid

    return uuid.UUID(value)
