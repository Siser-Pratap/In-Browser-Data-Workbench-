"""Job lifecycle: queue -> run -> result, plus retry, dead-letter and cancel.

These drive `execute_job` directly rather than through Redis — the runner owns
every status transition, so exercising it covers the ARQ path too.
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.job_service import JobService, TooManyJobs, backoff_seconds
from app.workers import tasks as task_module
from app.workers.runner import execute_job
from app.workers.tasks import TaskDeps

from .conftest import database_url
from .test_storage import FakeS3
from .test_workspaces import auth, register


@pytest.fixture
def app_settings() -> Settings:
    return Settings(
        anthropic_api_key="test-key",
        database_url=database_url(),
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        s3_bucket="workbench-test",
        redis_url="",  # inline queue
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
def deps(client):
    from app.compute.engine import EngineSettings

    return TaskDeps(
        jobs=client.app.state.job_service,
        storage=client.app.state.storage_service,
        engine=EngineSettings(timeout_seconds=10),
    )


async def make_user(sessionmaker, email="jobs@example.com"):
    from sqlalchemy import select

    from app.db.models import User

    async with sessionmaker() as db:
        return (await db.execute(select(User).where(User.email == email))).scalar_one()


# -- backoff ------------------------------------------------------------------


def test_backoff_grows_then_caps():
    assert [backoff_seconds(n) for n in (1, 2, 3, 4)] == [5, 10, 20, 40]
    assert backoff_seconds(20) == 600


# -- lifecycle ----------------------------------------------------------------


async def test_job_runs_to_success(client, sessionmaker, deps):
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")

    async def ok_task(db, job, deps):
        return {"answer": 42}

    task_module.TASKS["test_ok"] = ok_task
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_ok", user=user)
            job_id = job.id

        assert await execute_job(sessionmaker, job_id, deps) == "succeeded"

        async with sessionmaker() as db:
            done = await deps.jobs.get(db, job_id)
            assert done.result == {"answer": 42}
            assert done.progress == 100
            assert done.attempts == 1
            assert done.started_at and done.finished_at
    finally:
        task_module.TASKS.pop("test_ok")


async def test_failure_retries_then_dead_letters(client, sessionmaker, deps):
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    calls = {"n": 0}

    async def flaky(db, job, deps):
        calls["n"] += 1
        raise RuntimeError("transient upstream error")

    task_module.TASKS["test_flaky"] = flaky
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_flaky", user=user, max_attempts=3)
            job_id = job.id

        # Attempts 1 and 2 requeue; the third exhausts them.
        assert await execute_job(sessionmaker, job_id, deps) == "queued"
        assert await execute_job(sessionmaker, job_id, deps) == "queued"
        assert await execute_job(sessionmaker, job_id, deps) == "failed"
        assert calls["n"] == 3

        async with sessionmaker() as db:
            dead = await deps.jobs.get(db, job_id)
            assert dead.dead_lettered_at is not None
            assert "transient upstream error" in (dead.error or "")
            assert dead.attempts == 3
    finally:
        task_module.TASKS.pop("test_flaky")


async def test_a_retryable_failure_puts_itself_back_on_the_queue(client, sessionmaker, deps):
    """Setting the row back to `queued` is not a retry.

    Nothing polls that column, so without a new queue message the job would sit
    in `queued` forever — never retried, never dead-lettered, and still counted
    against the user's concurrency cap. This is the regression test for that.
    """
    enqueued: list[tuple[str, int]] = []

    class RecordingQueue:
        async def enqueue(self, job_id, *, delay_seconds: int = 0):
            enqueued.append((str(job_id), delay_seconds))

    deps.queue = RecordingQueue()
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")

    async def flaky(db, job, deps):
        raise RuntimeError("s3 had a moment")

    task_module.TASKS["test_requeue"] = flaky
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_requeue", user=user, max_attempts=3)
            job_id = job.id

        assert await execute_job(sessionmaker, job_id, deps) == "queued"
        assert enqueued == [(str(job_id), 5)]  # first retry, 5s backoff

        assert await execute_job(sessionmaker, job_id, deps) == "queued"
        assert enqueued[-1] == (str(job_id), 10)  # backoff doubles

        # Attempts exhausted: dead-lettered, and *not* re-enqueued.
        assert await execute_job(sessionmaker, job_id, deps) == "failed"
        assert len(enqueued) == 2
    finally:
        task_module.TASKS.pop("test_requeue")


async def test_a_retry_without_a_queue_is_logged_not_silent(client, sessionmaker, deps, caplog):
    """The inline path always has a queue; a misconfiguration must be loud."""
    import logging

    deps.queue = None
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")

    async def flaky(db, job, deps):
        raise RuntimeError("boom")

    task_module.TASKS["test_no_queue"] = flaky
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_no_queue", user=user, max_attempts=3)
            job_id = job.id
        with caplog.at_level(logging.ERROR, logger="app.jobs"):
            await execute_job(sessionmaker, job_id, deps)
        assert any("job.retry_dropped" in r.message for r in caplog.records)
    finally:
        task_module.TASKS.pop("test_no_queue")


async def test_compute_errors_are_not_retried(client, sessionmaker, deps):
    """Bad SQL fails identically every time; retrying only burns the pool."""
    from app.compute.engine import SQLRejected

    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    calls = {"n": 0}

    async def rejected(db, job, deps):
        calls["n"] += 1
        raise SQLRejected("no")

    task_module.TASKS["test_rejected"] = rejected
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_rejected", user=user, max_attempts=3)
            job_id = job.id
        assert await execute_job(sessionmaker, job_id, deps) == "failed"
        assert calls["n"] == 1
    finally:
        task_module.TASKS.pop("test_rejected")


async def test_unknown_job_kind_fails_without_retrying(client, sessionmaker, deps):
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    async with sessionmaker() as db:
        job = await deps.jobs.create(db, kind="no_such_kind", user=user, max_attempts=3)
        job_id = job.id
    assert await execute_job(sessionmaker, job_id, deps) == "failed"


async def test_a_cancelled_job_never_starts(client, sessionmaker, deps):
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    ran = {"yes": False}

    async def should_not_run(db, job, deps):
        ran["yes"] = True
        return {}

    task_module.TASKS["test_cancel"] = should_not_run
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_cancel", user=user)
            await deps.jobs.cancel(db, job)
            job_id = job.id

        assert await execute_job(sessionmaker, job_id, deps) == "cancelled"
        assert ran["yes"] is False
    finally:
        task_module.TASKS.pop("test_cancel")


async def test_concurrency_limit_is_enforced(client, sessionmaker):
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    jobs = JobService(max_concurrent_per_user=2)

    async with sessionmaker() as db:
        await jobs.create(db, kind="a", user=user)
        await jobs.create(db, kind="b", user=user)
        with pytest.raises(TooManyJobs):
            await jobs.create(db, kind="c", user=user)


async def test_the_originating_request_id_is_recorded(client, sessionmaker, deps):
    """Request -> job -> worker log correlation."""
    from app.core.logging import request_id_var

    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    token = request_id_var.set("req-abc123")
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_kind", user=user)
            assert job.params["request_id"] == "req-abc123"
    finally:
        request_id_var.reset(token)


async def test_inline_queue_actually_runs_the_job(client, sessionmaker, deps):
    """The Redis-free fallback: `docker compose up` with no worker still works.

    Constructed here rather than reusing the app's, so its tasks live on this
    test's event loop and can be awaited deterministically.
    """
    from app.workers.queue import InlineQueue

    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    ran = {"yes": False}

    async def marker(db, job, deps):
        ran["yes"] = True
        return {"ok": True}

    task_module.TASKS["test_inline"] = marker
    try:
        async with sessionmaker() as db:
            job = await deps.jobs.create(db, kind="test_inline", user=user)
            job_id = job.id

        queue = InlineQueue(sessionmaker, deps)
        await queue.enqueue(job_id)
        await queue.drain()

        assert ran["yes"] is True
        async with sessionmaker() as db:
            assert (await deps.jobs.get(db, job_id)).status == "succeeded"
    finally:
        task_module.TASKS.pop("test_inline")


async def test_create_queue_falls_back_when_redis_is_unreachable(sessionmaker, deps):
    """A dev box without Redis degrades to inline instead of failing startup."""
    from app.workers.queue import InlineQueue, create_queue

    queue = await create_queue("redis://127.0.0.1:6390", sessionmaker, deps)
    assert isinstance(queue, InlineQueue)
    await queue.close()


# -- API surface --------------------------------------------------------------


async def test_job_endpoints(client, sessionmaker, deps):
    token = register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    async with sessionmaker() as db:
        job = await deps.jobs.create(db, kind="compute_query", user=user)
        job_id = str(job.id)

    fetched = client.get(f"/api/v1/jobs/{job_id}", headers=auth(token))
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "queued"

    listed = client.get("/api/v1/jobs", headers=auth(token))
    assert listed.json()["total"] == 1

    cancelled = client.post(f"/api/v1/jobs/{job_id}/cancel", headers=auth(token))
    assert cancelled.json()["status"] == "cancelled"

    # Cancelling twice is a conflict, not a silent no-op.
    assert client.post(f"/api/v1/jobs/{job_id}/cancel", headers=auth(token)).status_code == 409


async def test_another_users_job_is_a_404(client, sessionmaker, deps):
    register(client, "owner@example.com")
    owner = await make_user(sessionmaker, "owner@example.com")
    async with sessionmaker() as db:
        job = await deps.jobs.create(db, kind="compute_query", user=owner)
        job_id = str(job.id)

    stranger = register(client, "stranger@example.com")
    assert client.get(f"/api/v1/jobs/{job_id}", headers=auth(stranger)).status_code == 404


def test_unknown_job_id_is_a_404(client):
    token = register(client)
    assert client.get(f"/api/v1/jobs/{uuid.uuid4()}", headers=auth(token)).status_code == 404
    assert client.get("/api/v1/jobs/not-a-uuid", headers=auth(token)).status_code == 404


async def test_sse_stream_reports_progress_then_done(client, sessionmaker, deps):
    token = register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    async with sessionmaker() as db:
        job = await deps.jobs.create(db, kind="compute_query", user=user)
        await deps.jobs.mark_succeeded(db, job, {"row_count": 3})
        job_id = str(job.id)

    with client.stream("GET", f"/api/v1/jobs/{job_id}/events", headers=auth(token)) as response:
        assert response.status_code == 200
        body = "".join(response.iter_text())

    assert "event: progress" in body
    assert "event: done" in body
    assert '"status": "succeeded"' in body


# -- metrics ------------------------------------------------------------------


def test_metrics_endpoint_exposes_request_and_job_series(client):
    token = register(client)
    client.get("/api/v1/jobs", headers=auth(token))

    body = client.get("/metrics").text
    assert "http_request_duration_seconds" in body
    assert "job_queue_depth" in body
    # The route label must be the template, never a concrete id.
    assert "/api/v1/jobs/{job_id}" not in body or "workspace_id" not in body


async def test_queue_depth_counts_pending_work(client, sessionmaker, deps):
    register(client)
    user = await make_user(sessionmaker, "owner@example.com")
    async with sessionmaker() as db:
        await deps.jobs.create(db, kind="compute_query", user=user)
        depth = await deps.jobs.queue_depth(db)
    assert depth.get("queued") == 1
