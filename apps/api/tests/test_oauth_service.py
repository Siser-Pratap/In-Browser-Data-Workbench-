"""Unit tests for the OAuth account-linking logic (no HTTP / provider needed)."""

import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import OAuthAccount, User
from app.services.oauth_service import OAuthService


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        yield s
    await engine.dispose()


async def test_creates_verified_user_for_new_identity(session):
    user = await OAuthService().link_or_create(session, "google", "g-123", "new@example.com")
    assert user.email == "new@example.com"
    assert user.is_verified is True
    assert user.password_hash is None


async def test_links_to_existing_user_by_email(session):
    existing = User(email="ada@example.com", password_hash=hash_password("pw12345678"))
    session.add(existing)
    await session.commit()

    user = await OAuthService().link_or_create(session, "github", "gh-9", "ada@example.com")
    assert user.id == existing.id
    linked = (await session.get(OAuthAccount, (await _only_oauth(session)).id))
    assert linked.provider == "github"


async def test_returns_same_user_for_known_identity(session):
    svc = OAuthService()
    first = await svc.link_or_create(session, "google", "g-1", "x@example.com")
    second = await svc.link_or_create(session, "google", "g-1", "x@example.com")
    assert first.id == second.id
    # No duplicate oauth account row.
    from sqlalchemy import func, select

    count = (await session.execute(select(func.count()).select_from(OAuthAccount))).scalar()
    assert count == 1


async def _only_oauth(session) -> OAuthAccount:
    from sqlalchemy import select

    return (await session.execute(select(OAuthAccount))).scalars().first()
