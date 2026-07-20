import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture
def client():
    settings = Settings(
        anthropic_api_key="test-key",
        database_url="sqlite+aiosqlite:///:memory:",
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
