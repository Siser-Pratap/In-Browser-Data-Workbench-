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
