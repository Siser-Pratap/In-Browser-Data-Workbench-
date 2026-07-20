from collections.abc import AsyncIterator
from dataclasses import dataclass

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
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    return Database(engine=engine, sessionmaker=maker)
