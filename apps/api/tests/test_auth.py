"""End-to-end auth lifecycle tests against a real (SQLite) database.

Uses `with TestClient(app)` so the lifespan runs and `db_auto_create` builds the
schema. The email service is a stub whose `sent` list stands in for an inbox, so
verification and reset tokens are recoverable without a mail provider.
"""

import re

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture
def app_settings() -> Settings:
    return Settings(
        anthropic_api_key="test-key",
        database_url="sqlite+aiosqlite:///:memory:",
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        _env_file=None,
    )


@pytest.fixture
def client(app_settings):
    app = create_app(app_settings)
    with TestClient(app) as c:
        yield c


def _token_from_email(app, kind: str) -> str:
    body = app.state.email_service.sent[-1]["body"]
    return re.search(r"token=([^\s]+)", body).group(1)


def signup(client, email="user@example.com", password="hunter2pass"):
    return client.post("/api/v1/auth/signup", json={"email": email, "password": password})


def login(client, email="user@example.com", password="hunter2pass"):
    return client.post("/api/v1/auth/login", json={"email": email, "password": password})


# -- signup / verify ----------------------------------------------------------


def test_signup_creates_unverified_user_and_sends_email(client):
    resp = signup(client)
    assert resp.status_code == 201
    body = resp.json()
    assert body["email"] == "user@example.com"
    assert body["is_verified"] is False
    assert len(client.app.state.email_service.sent) == 1


def test_signup_duplicate_email_conflicts(client):
    signup(client)
    resp = signup(client)
    assert resp.status_code == 409
    assert resp.json()["code"] == "email_already_registered"
    assert resp.headers["content-type"].startswith("application/problem+json")


def test_email_verification_flow(client):
    signup(client)
    token = _token_from_email(client.app, "verify")
    resp = client.post("/api/v1/auth/verify-email", json={"token": token})
    assert resp.status_code == 200
    assert resp.json()["is_verified"] is True


def test_verify_with_bad_token_401(client):
    signup(client)
    resp = client.post("/api/v1/auth/verify-email", json={"token": "garbage"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "invalid_token"


# -- login / me ---------------------------------------------------------------


def test_login_returns_access_token_and_refresh_cookie(client):
    signup(client)
    resp = login(client)
    assert resp.status_code == 200
    assert resp.json()["token_type"] == "bearer"
    assert "workbench_refresh" in resp.cookies


def test_login_wrong_password_401(client):
    signup(client)
    resp = login(client, password="wrongpassword")
    assert resp.status_code == 401
    assert resp.json()["code"] == "invalid_credentials"


def test_login_unknown_email_401(client):
    resp = login(client, email="nobody@example.com")
    assert resp.status_code == 401


def test_me_requires_auth(client):
    assert client.get("/api/v1/users/me").status_code == 401


def test_me_with_access_token(client):
    signup(client)
    token = login(client).json()["access_token"]
    resp = client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["email"] == "user@example.com"


def test_update_display_name(client):
    signup(client)
    token = login(client).json()["access_token"]
    resp = client.patch(
        "/api/v1/users/me",
        json={"display_name": "Ada"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.json()["display_name"] == "Ada"


# -- refresh rotation & reuse detection ---------------------------------------


def test_refresh_rotates_and_issues_new_tokens(client):
    signup(client)
    login(client)
    first = client.post("/api/v1/auth/refresh")
    assert first.status_code == 200
    assert "workbench_refresh" in first.cookies
    # New cookie works again.
    second = client.post("/api/v1/auth/refresh")
    assert second.status_code == 200


def test_refresh_reuse_revokes_family(client):
    signup(client)
    login(client)
    old_cookie = client.cookies.get("workbench_refresh")

    # Rotate once; the old token is now consumed and the jar holds the new one.
    client.post("/api/v1/auth/refresh")
    rotated_cookie = client.cookies.get("workbench_refresh")

    # Replay the OLD token -> reuse detected -> whole family revoked.
    client.cookies.set("workbench_refresh", old_cookie)
    reused = client.post("/api/v1/auth/refresh")
    assert reused.status_code == 401
    assert reused.json()["code"] == "token_reused"

    # The current (rotated) token is now dead too, because the family was revoked.
    client.cookies.set("workbench_refresh", rotated_cookie)
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_refresh_without_cookie_401(client):
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_logout_revokes_refresh(client):
    signup(client)
    login(client)
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert client.post("/api/v1/auth/refresh").status_code == 401


# -- password reset -----------------------------------------------------------


def test_forgot_password_is_uniform_for_unknown_email(client):
    resp = client.post("/api/v1/auth/password/forgot", json={"email": "nobody@example.com"})
    assert resp.status_code == 200
    assert client.app.state.email_service.sent == []


def test_password_reset_flow(client):
    signup(client)
    client.post("/api/v1/auth/password/forgot", json={"email": "user@example.com"})
    token = _token_from_email(client.app, "reset")

    reset = client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "newpass1234"}
    )
    assert reset.status_code == 200

    assert login(client, password="hunter2pass").status_code == 401
    assert login(client, password="newpass1234").status_code == 200


def test_reset_token_is_single_use(client):
    signup(client)
    client.post("/api/v1/auth/password/forgot", json={"email": "user@example.com"})
    token = _token_from_email(client.app, "reset")
    client.post("/api/v1/auth/password/reset", json={"token": token, "password": "newpass1234"})
    # Reusing the same token fails — it was bound to the old password.
    again = client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "another12345"}
    )
    assert again.status_code == 401


def test_password_reset_revokes_existing_sessions(client):
    signup(client)
    login(client)
    client.post("/api/v1/auth/password/forgot", json={"email": "user@example.com"})
    token = _token_from_email(client.app, "reset")
    client.post("/api/v1/auth/password/reset", json={"token": token, "password": "newpass1234"})
    # The pre-reset refresh cookie is now invalid.
    assert client.post("/api/v1/auth/refresh").status_code == 401


# -- account deletion ---------------------------------------------------------


def test_delete_account_is_real(client):
    signup(client)
    token = login(client).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.delete("/api/v1/users/me", headers=headers).status_code == 200
    # Token no longer resolves to a user.
    assert client.get("/api/v1/users/me", headers=headers).status_code == 401
    # Email is free again.
    assert signup(client).status_code == 201


# -- health -------------------------------------------------------------------


def test_healthz_and_readyz(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    ready = client.get("/readyz").json()
    assert ready["status"] == "ready"
    assert ready["checks"]["database"] == "ok"


def test_request_id_header_present(client):
    resp = client.get("/healthz")
    assert resp.headers.get("X-Request-ID")
