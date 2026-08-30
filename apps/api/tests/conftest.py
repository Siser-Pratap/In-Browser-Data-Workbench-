"""Shared test configuration.

The suite runs on SQLite by default — fast, no services, fine for logic. But
SQLite is not PostgreSQL, and the difference has bitten: a snapshot save that
INSERTed charts before the queries they reference passed on SQLite for weeks and
failed on PostgreSQL every single time. So the same suite can be pointed at a
real database:

    TEST_DATABASE_URL=postgresql+asyncpg://workbench:workbench@localhost:5432/workbench \
        uv run pytest -q

SQLite gets `PRAGMA foreign_keys=ON` (see `db/session.py`) so it enforces the
same referential integrity locally.
"""

import asyncio
import os

import pytest

SQLITE_URL = "sqlite+aiosqlite:///:memory:"


def database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL", SQLITE_URL)


def on_postgres() -> bool:
    return "postgresql" in database_url()


@pytest.fixture(autouse=True)
def isolate_database():
    """Give every test an empty database.

    A SQLite in-memory database is born empty and dies with the test, so this is
    a no-op there. A shared PostgreSQL instance is not: without truncation,
    fixtures that sign up `owner@example.com` collide with the previous test.
    """
    if not on_postgres():
        yield
        return

    _truncate_all()
    yield


@pytest.fixture
async def sessionmaker(client):
    """A session factory usable from inside an async test.

    On SQLite this must be the app's own factory: an in-memory database lives
    inside its engine, so a second engine would see a different, empty one.

    On PostgreSQL it must *not* be. `TestClient` runs the app on its own event
    loop, and asyncpg binds its pool to the loop that created it — reusing the
    app's factory from the test's loop raises "attached to a different loop".
    A separate engine on this loop talks to the same database.
    """
    if not on_postgres():
        yield client.app.state.db.sessionmaker
        return

    from app.db.session import create_database

    database = create_database(database_url())
    try:
        yield database.sessionmaker
    finally:
        await database.dispose()


def _truncate_all() -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def run() -> None:
        engine = create_async_engine(database_url())
        try:
            async with engine.begin() as conn:
                tables = (
                    await conn.execute(
                        text(
                            "SELECT tablename FROM pg_tables "
                            "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
                        )
                    )
                ).scalars().all()
                if tables:
                    joined = ", ".join(f'"{t}"' for t in tables)
                    await conn.execute(text(f"TRUNCATE {joined} RESTART IDENTITY CASCADE"))
        finally:
            await engine.dispose()

    asyncio.run(run())
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest

from app.ai.schemas import ColumnSchema, TableSchema
from app.core.config import Settings


@pytest.fixture(autouse=True, scope="session")
def _isolate_ambient_env():
    """Keep the process environment out of the tests.

    `_env_file=None` stops pydantic-settings reading a `.env`, but it does *not*
    stop it reading `os.environ` — so a container that exports `ENVIRONMENT` or
    a real API key silently changes what every `Settings(...)` in the suite
    resolves to. That is not hypothetical: the dev compose file sets
    `ENVIRONMENT=development`, which made every AI test resolve to the empty
    development key and answer 503.

    Cleared session-wide rather than fixed per call site, because the next
    setting anyone adds would otherwise reintroduce the same leak.
    """
    saved = {name: os.environ.pop(name, None) for name in _AMBIENT}
    yield
    for name, value in saved.items():
        if value is not None:
            os.environ[name] = value


_AMBIENT = ("ENVIRONMENT", "GEMINI_API_KEY", "GEMINI_API_KEY_DEV", "AI_MODEL", "S3_BUCKET")


@pytest.fixture
def settings() -> Settings:
    # Explicit about the environment as well as the key: which of the two keys
    # is live is exactly what these tests must not leave to ambient config.
    return Settings(environment="production", gemini_api_key="test-key", _env_file=None)


@pytest.fixture
def sales_profile() -> dict:
    """A TableProfile document as the frontend would send it."""
    return {
        "version": 1,
        "table": "sales",
        "row_count": 1000,
        "columns": [
            {
                "name": "region",
                "type": "VARCHAR",
                "null_pct": 0.0,
                "distinct_count": 4,
                "top_values": [
                    {"value": "EMEA", "count": 400},
                    {"value": "n/a", "count": 50},
                ],
            },
            {
                "name": "amount",
                "type": "DOUBLE",
                "null_pct": 2.5,
                "numeric": {"min": -10.0, "max": 950.0, "mean": 120.0},
            },
            {
                "name": "sold_at",
                "type": "VARCHAR",
                "null_pct": 0.0,
                "patterns": {"regex_iso_date_match_pct": 99.1},
            },
        ],
        "candidate_keys": [],
        "sample_rows_included": False,
    }


@pytest.fixture
def sales_table() -> TableSchema:
    return TableSchema(
        name="sales",
        columns=[
            ColumnSchema(name="id", type="INTEGER"),
            ColumnSchema(name="region", type="VARCHAR"),
            ColumnSchema(name="amount", type="DOUBLE"),
            ColumnSchema(name="sold_at", type="TIMESTAMP"),
        ],
        row_count=1000,
        samples={"region": ["EMEA", "APAC"]},
        column_stats={"amount": {"min": 1, "max": 950}},
    )
