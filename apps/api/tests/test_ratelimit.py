import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

from .conftest import database_url


@pytest.fixture
def client():
    settings = Settings(
        anthropic_api_key="test-key",
        database_url=database_url(),
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        rate_limit_auth_per_minute=3,
        _env_file=None,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def test_auth_endpoint_rate_limited_with_retry_after(client):
    # 3 allowed per minute; the 4th trips the limiter.
    payload = {"email": "nobody@example.com", "password": "whatever12"}
    statuses = [client.post("/api/v1/auth/login", json=payload).status_code for _ in range(4)]
    assert statuses[:3] == [401, 401, 401]  # wrong creds, but allowed through
    limited = client.post("/api/v1/auth/login", json=payload)
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 0
    assert limited.json()["status"] == 429


def test_non_auth_endpoints_not_limited_by_auth_bucket(client):
    # The generous default bucket doesn't trip on a handful of health checks.
    for _ in range(10):
        assert client.get("/healthz").status_code == 200


def test_the_default_limit_actually_applies_to_the_expensive_endpoints():
    """`rate_limit_default_per_minute` was dead config: every call site passed
    `auth=True`, so setting it had no effect anywhere."""
    settings = Settings(
        anthropic_api_key="",
        database_url=database_url(),
        db_auto_create=True,
        jwt_secret="test-secret",
        rate_limit_default_per_minute=2,
        _env_file=None,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        body = {"question": "q", "tables": [{"name": "t", "columns": []}]}
        # AI is unconfigured here, so these 503 — but they must still be counted.
        assert c.post("/api/v1/ai/sql", json=body).status_code == 503
        assert c.post("/api/v1/ai/sql", json=body).status_code == 503
        limited = c.post("/api/v1/ai/sql", json=body)
        assert limited.status_code == 429
        assert "Retry-After" in limited.headers


def test_stale_windows_are_evicted_instead_of_accumulating():
    """One entry per client IP, never released, is an unbounded leak."""
    from app.core.ratelimit import RateLimiter

    limiter = RateLimiter(max_tracked_keys=10)
    # Entries from a window that has already closed carry no information.
    limiter._hits.update({f"old:{i}": (1, 0) for i in range(50)})
    limiter.check("current", limit=100)

    assert len(limiter._hits) <= 11
    assert "current" in limiter._hits
