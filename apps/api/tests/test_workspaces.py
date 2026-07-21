"""Workspace persistence, snapshot sync and sharing, end to end.

Same shape as test_auth.py: a real (SQLite) database behind `TestClient`, with
`db_auto_create` building the schema during lifespan.
"""

import re

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

from .conftest import database_url


@pytest.fixture
def app_settings() -> Settings:
    return Settings(
        anthropic_api_key="test-key",
        # A file-backed temp DB would be needed for multiple engines; one
        # in-memory database is shared by every session here.
        database_url=database_url(),
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        frontend_base_url="http://localhost:3000",
        _env_file=None,
    )


@pytest.fixture
def client(app_settings):
    app = create_app(app_settings)
    with TestClient(app) as c:
        yield c


def register(client, email="owner@example.com") -> str:
    """Sign up, verify, log in; returns the access token."""
    client.post("/api/v1/auth/signup", json={"email": email, "password": "hunter2pass"})
    body = client.app.state.email_service.sent[-1]["body"]
    token = re.search(r"token=([^\s]+)", body).group(1)
    client.post("/api/v1/auth/verify-email", json={"token": token})
    resp = client.post("/api/v1/auth/login", json={"email": email, "password": "hunter2pass"})
    return resp.json()["access_token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def create_workspace(client, token, name="Sales analysis") -> dict:
    resp = client.post("/api/v1/workspaces", json={"name": name}, headers=auth(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


SNAPSHOT = {
    "name": "Sales analysis",
    "description": "Q3 numbers",
    "settings": {"theme": "dark"},
    "datasets": [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "orders",
            "source_filename": "orders.csv",
            "format": "csv",
            "schema": {"columns": [{"name": "id", "type": "BIGINT"}]},
            "row_count": 1000,
            "byte_size": 4096,
        }
    ],
    "queries": [
        {
            "id": "22222222-2222-2222-2222-222222222222",
            "name": "top customers",
            "sql": "SELECT * FROM orders LIMIT 10",
            "position": 0,
        }
    ],
    "charts": [
        {
            "id": "33333333-3333-3333-3333-333333333333",
            "query_id": "22222222-2222-2222-2222-222222222222",
            "spec": {"version": 1, "type": "bar", "x": "customer"},
        }
    ],
    "dashboards": [
        {
            "id": "44444444-4444-4444-4444-444444444444",
            "name": "Overview",
            "layout": {"version": 1, "grid": []},
        }
    ],
}


# -- CRUD ---------------------------------------------------------------------


def test_create_and_list_workspaces(client):
    token = register(client)
    created = create_workspace(client, token)
    assert created["name"] == "Sales analysis"

    listed = client.get("/api/v1/workspaces", headers=auth(token)).json()
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == created["id"]


def test_list_excludes_other_users_workspaces(client):
    owner = register(client, "owner@example.com")
    create_workspace(client, owner)
    stranger = register(client, "stranger@example.com")

    listed = client.get("/api/v1/workspaces", headers=auth(stranger)).json()
    assert listed["total"] == 0


def test_stranger_gets_404_not_403_on_someone_elses_workspace(client):
    owner = register(client, "owner@example.com")
    workspace = create_workspace(client, owner)
    stranger = register(client, "stranger@example.com")

    resp = client.get(f"/api/v1/workspaces/{workspace['id']}", headers=auth(stranger))
    assert resp.status_code == 404


def test_update_and_soft_delete(client):
    token = register(client)
    workspace = create_workspace(client, token)

    patched = client.patch(
        f"/api/v1/workspaces/{workspace['id']}",
        json={"name": "Renamed"},
        headers=auth(token),
    )
    assert patched.json()["name"] == "Renamed"

    deleted = client.delete(f"/api/v1/workspaces/{workspace['id']}", headers=auth(token))
    assert deleted.status_code == 204
    # Deleted workspaces drop out of the list but stay readable to their owner.
    assert client.get("/api/v1/workspaces", headers=auth(token)).json()["total"] == 0


# -- snapshot round trip ------------------------------------------------------


def test_snapshot_round_trip_is_identical_on_another_device(client):
    token = register(client)
    workspace = create_workspace(client, token)
    url = f"/api/v1/workspaces/{workspace['id']}/snapshot"

    saved = client.put(url, json=SNAPSHOT, headers=auth(token))
    assert saved.status_code == 200, saved.text

    # "Another device": a fresh login, same account.
    other_session = client.post(
        "/api/v1/auth/login", json={"email": "owner@example.com", "password": "hunter2pass"}
    ).json()["access_token"]
    fetched = client.get(url, headers=auth(other_session))
    assert fetched.status_code == 200

    a, b = saved.json(), fetched.json()
    assert a["datasets"] == b["datasets"]
    assert a["queries"] == b["queries"]
    assert a["charts"] == b["charts"]
    assert a["dashboards"] == b["dashboards"]
    assert b["workspace"]["settings"] == {"theme": "dark"}
    assert b["datasets"][0]["schema"] == {"columns": [{"name": "id", "type": "BIGINT"}]}
    assert b["charts"][0]["query_id"] == "22222222-2222-2222-2222-222222222222"


def test_snapshot_deletes_rows_the_client_dropped(client):
    token = register(client)
    workspace = create_workspace(client, token)
    url = f"/api/v1/workspaces/{workspace['id']}/snapshot"
    client.put(url, json=SNAPSHOT, headers=auth(token))

    trimmed = {**SNAPSHOT, "queries": [], "charts": []}
    body = client.put(url, json=trimmed, headers=auth(token)).json()
    assert body["queries"] == []
    assert body["charts"] == []
    assert len(body["datasets"]) == 1


def test_charts_are_written_after_the_queries_they_reference(client):
    """Regression: the snapshot save INSERTed charts before queries.

    `Chart.query_id` is a bare FK column with no `relationship()`, so the unit
    of work has no idea charts depend on queries. SQLite with foreign keys off
    accepted it; PostgreSQL rejected every save containing a chart. The test
    database now enforces foreign keys, so this fails loudly if it regresses.
    """
    token = register(client)
    workspace = create_workspace(client, token)
    many_charts = {
        **SNAPSHOT,
        "queries": [
            {
                "id": f"55555555-0000-4000-8000-{i:012d}",
                "name": f"q{i}",
                "sql": "SELECT 1",
                "position": i,
            }
            for i in range(10)
        ],
        "charts": [
            {
                "id": f"66666666-0000-4000-8000-{i:012d}",
                "query_id": f"55555555-0000-4000-8000-{i:012d}",
                "spec": {"version": 1, "type": "line"},
            }
            for i in range(10)
        ],
    }
    saved = client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot",
        json=many_charts,
        headers=auth(token),
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert len(body["charts"]) == 10
    assert all(c["query_id"] is not None for c in body["charts"])


def test_reusing_another_workspaces_id_is_a_409_not_a_500(client):
    """Child ids are client-supplied and globally unique keys.

    Saving a document whose ids already live in another workspace — e.g. one
    copied from elsewhere — used to surface as an unhandled IntegrityError and
    a 500. It's bad input, so it has to read as one.
    """
    token = register(client)
    first = create_workspace(client, token, name="First")
    second = create_workspace(client, token, name="Second")

    body = {
        "queries": [
            {
                "id": "77777777-0000-4000-8000-000000000001",
                "name": "q",
                "sql": "SELECT 1",
                "position": 0,
            }
        ]
    }
    assert client.put(
        f"/api/v1/workspaces/{first['id']}/snapshot", json=body, headers=auth(token)
    ).status_code == 200

    clash = client.put(
        f"/api/v1/workspaces/{second['id']}/snapshot", json=body, headers=auth(token)
    )
    assert clash.status_code == 409
    assert clash.json()["code"] == "id_conflict"

    # The failed save left nothing behind.
    after = client.get(
        f"/api/v1/workspaces/{second['id']}/snapshot", headers=auth(token)
    ).json()
    assert after["queries"] == []


def test_snapshot_conflict_returns_409_with_the_server_version(client):
    token = register(client)
    workspace = create_workspace(client, token)
    url = f"/api/v1/workspaces/{workspace['id']}/snapshot"

    first = client.get(url, headers=auth(token))
    stale_etag = first.headers["etag"]

    # Session A saves; its ETag is now the current one.
    client.put(url, json=SNAPSHOT, headers={**auth(token), "If-Match": stale_etag})

    # Session B still holds the pre-save ETag.
    conflict = client.put(
        url, json={**SNAPSHOT, "name": "Divergent"}, headers={**auth(token), "If-Match": stale_etag}
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "version_conflict"

    server_version = client.get(url, headers=auth(token)).json()
    assert server_version["workspace"]["name"] == "Sales analysis"


def test_snapshot_without_if_match_saves_unconditionally(client):
    token = register(client)
    workspace = create_workspace(client, token)
    url = f"/api/v1/workspaces/{workspace['id']}/snapshot"
    assert client.put(url, json=SNAPSHOT, headers=auth(token)).status_code == 200


def test_chart_spec_envelope_is_validated(client):
    token = register(client)
    workspace = create_workspace(client, token)
    bad = {**SNAPSHOT, "charts": [{"spec": {"type": "bar"}}]}  # no version
    resp = client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot", json=bad, headers=auth(token)
    )
    assert resp.status_code == 422


# -- nested CRUD --------------------------------------------------------------


def test_nested_query_crud(client):
    token = register(client)
    workspace = create_workspace(client, token)
    base = f"/api/v1/workspaces/{workspace['id']}/queries"

    created = client.post(
        base, json={"name": "q1", "sql": "SELECT 1", "position": 0}, headers=auth(token)
    )
    assert created.status_code == 201, created.text
    query_id = created.json()["id"]

    patched = client.patch(
        f"{base}/{query_id}",
        json={"name": "q1 renamed", "sql": "SELECT 2", "position": 1},
        headers=auth(token),
    )
    assert patched.json()["sql"] == "SELECT 2"

    assert client.get(base, headers=auth(token)).json()[0]["name"] == "q1 renamed"
    assert client.delete(f"{base}/{query_id}", headers=auth(token)).status_code == 204
    assert client.get(base, headers=auth(token)).json() == []


def test_nested_write_is_refused_for_a_stranger(client):
    owner = register(client, "owner@example.com")
    workspace = create_workspace(client, owner)
    stranger = register(client, "stranger@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{workspace['id']}/queries",
        json={"name": "q", "sql": "SELECT 1"},
        headers=auth(stranger),
    )
    assert resp.status_code == 404


# -- sharing ------------------------------------------------------------------


def test_share_link_reads_without_auth_and_revocation_is_immediate(client):
    token = register(client)
    workspace = create_workspace(client, token)
    client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot", json=SNAPSHOT, headers=auth(token)
    )

    share = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share",
        json={"include_data": False},
        headers=auth(token),
    )
    assert share.status_code == 200
    share_token = share.json()["share_token"]
    assert share.json()["share_url"].endswith(f"/shared/{share_token}")

    # No Authorization header at all.
    public = client.get(f"/api/v1/shared/{share_token}")
    assert public.status_code == 200
    assert public.json()["workspace"]["name"] == "Sales analysis"
    assert len(public.json()["queries"]) == 1

    assert client.delete(
        f"/api/v1/workspaces/{workspace['id']}/share", headers=auth(token)
    ).status_code == 204
    assert client.get(f"/api/v1/shared/{share_token}").status_code == 404


def test_rotating_the_share_token_invalidates_the_old_link(client):
    token = register(client)
    workspace = create_workspace(client, token)
    first = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(token)
    ).json()["share_token"]
    second = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(token)
    ).json()["share_token"]

    assert first != second
    assert client.get(f"/api/v1/shared/{first}").status_code == 404
    assert client.get(f"/api/v1/shared/{second}").status_code == 200


def test_share_link_grants_read_but_never_write(client):
    token = register(client)
    workspace = create_workspace(client, token)
    share_token = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(token)
    ).json()["share_token"]

    resp = client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot",
        json=SNAPSHOT,
        headers={"X-Share-Token": share_token},
    )
    assert resp.status_code == 401  # unauthenticated: writes need a real session


def test_deleting_a_workspace_kills_its_share_link(client):
    token = register(client)
    workspace = create_workspace(client, token)
    share_token = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(token)
    ).json()["share_token"]

    client.delete(f"/api/v1/workspaces/{workspace['id']}", headers=auth(token))
    assert client.get(f"/api/v1/shared/{share_token}").status_code == 404


def test_fork_creates_an_owned_copy(client):
    owner = register(client, "owner@example.com")
    workspace = create_workspace(client, owner)
    client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot", json=SNAPSHOT, headers=auth(owner)
    )
    share_token = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(owner)
    ).json()["share_token"]

    visitor = register(client, "visitor@example.com")
    forked = client.post(f"/api/v1/shared/{share_token}/fork", headers=auth(visitor))
    assert forked.status_code == 201, forked.text
    copy = forked.json()
    assert copy["id"] != workspace["id"]
    assert copy["name"] == "Sales analysis (copy)"

    # The copy is fully owned by the visitor, contents and all.
    snapshot = client.get(
        f"/api/v1/workspaces/{copy['id']}/snapshot", headers=auth(visitor)
    ).json()
    assert len(snapshot["queries"]) == 1
    assert len(snapshot["charts"]) == 1
    # Chart -> query references are remapped to the copied rows.
    assert snapshot["charts"][0]["query_id"] == snapshot["queries"][0]["id"]

    # Editing the fork leaves the original untouched.
    client.patch(f"/api/v1/workspaces/{copy['id']}", json={"name": "Mine"}, headers=auth(visitor))
    assert client.get(
        f"/api/v1/workspaces/{workspace['id']}", headers=auth(owner)
    ).json()["name"] == "Sales analysis"


def test_anonymous_visitor_cannot_fork(client):
    token = register(client)
    workspace = create_workspace(client, token)
    share_token = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(token)
    ).json()["share_token"]

    assert client.post(f"/api/v1/shared/{share_token}/fork").status_code == 401


def test_share_events_are_logged(client):
    from sqlalchemy import select

    token = register(client)
    workspace = create_workspace(client, token)
    share_token = client.post(
        f"/api/v1/workspaces/{workspace['id']}/share", json={}, headers=auth(token)
    ).json()["share_token"]
    client.get(f"/api/v1/shared/{share_token}")

    async def actions():
        from app.db.models import ActivityLog
        from app.db.session import create_database

        from .conftest import on_postgres

        # `asyncio.run` opens a fresh event loop, and asyncpg pools are bound to
        # the loop that made them — so on PostgreSQL this needs its own engine.
        # SQLite's in-memory database only exists inside the app's engine, so
        # there it must reuse that one.
        if on_postgres():
            database = create_database(database_url())
            try:
                async with database.sessionmaker() as db:
                    rows = (await db.execute(select(ActivityLog))).scalars()
                    return [r.action for r in rows]
            finally:
                await database.dispose()

        async with client.app.state.db.sessionmaker() as db:
            rows = (await db.execute(select(ActivityLog))).scalars()
            return [r.action for r in rows]

    import asyncio

    assert set(asyncio.run(actions())) == {"share", "view"}


# -- storage ------------------------------------------------------------------


def test_usage_starts_empty(client):
    token = register(client)
    usage = client.get("/api/v1/users/me/usage", headers=auth(token)).json()
    assert usage["used_bytes"] == 0
    assert usage["dataset_count"] == 0
    assert usage["quota_bytes"] == 1024**3


def test_upload_url_is_503_when_storage_is_not_configured(client):
    token = register(client)
    workspace = create_workspace(client, token)
    client.put(
        f"/api/v1/workspaces/{workspace['id']}/snapshot", json=SNAPSHOT, headers=auth(token)
    )
    dataset_id = SNAPSHOT["datasets"][0]["id"]

    resp = client.post(
        f"/api/v1/workspaces/{workspace['id']}/datasets/{dataset_id}/upload-url",
        json={"filename": "orders.csv", "byte_size": 1024},
        headers=auth(token),
    )
    assert resp.status_code == 503
    assert resp.json()["code"] == "storage_unavailable"
