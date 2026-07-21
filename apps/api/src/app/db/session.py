from collections.abc import AsyncIterator
from dataclasses import dataclass

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


@dataclass
class Database:
    engine: AsyncEngine
    sessionmaker: async_sessionmaker[AsyncSession]

    async def dispose(self) -> None:
        await self.engine.dispose()

    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.sessionmaker() as session:
            yield session


def create_database(url: str, echo: bool = False) -> Database:
    engine = create_async_engine(url, echo=echo, pool_pre_ping=True, future=True)
    _enforce_sqlite_foreign_keys(engine)
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    return Database(engine=engine, sessionmaker=maker)


def _enforce_sqlite_foreign_keys(engine: AsyncEngine) -> None:
    """Turn on FK enforcement for SQLite, which ships with it *off*.

    Tests run on SQLite and production on PostgreSQL. Without this, SQLite
    silently accepts rows that violate a foreign key, so the suite happily
    passes writes that PostgreSQL rejects outright — the test database has to
    be as strict as the real one or it is not evidence of anything.
    """
    if not engine.dialect.name.startswith("sqlite"):
        return

    @event.listens_for(engine.sync_engine, "connect")
    def _set_pragma(dbapi_connection, _record):  # pragma: no cover - driver hook
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
