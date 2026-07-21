from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..services.auth_service import AuthService
from ..services.errors import AccountInactive, InvalidToken
from ..services.storage_service import StorageService
from ..services.workspace_service import WorkspaceService
from .config import Settings
from .security import decode_access_token


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_auth_service(request: Request) -> AuthService:
    return request.app.state.auth_service


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db.sessionmaker() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
Auth = Annotated[AuthService, Depends(get_auth_service)]


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def current_user(
    db: DbSession,
    settings: SettingsDep,
    auth: Auth,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    """Require a valid access token; 401 otherwise."""
    token = _bearer(authorization)
    claims = decode_access_token(token, settings.jwt_secret) if token else None
    if claims is None:
        raise InvalidToken()
    user = await auth.get_user(db, claims["sub"])
    if user is None:
        raise InvalidToken()
    if not user.is_active or user.deleted_at is not None:
        raise AccountInactive()
    return user


CurrentUser = Annotated[User, Depends(current_user)]


async def optional_user_id(
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
    x_user_id: Annotated[str | None, Header(alias="X-User-Id")] = None,
) -> str:
    """Identity for local-first endpoints (the AI routes).

    A valid access token wins; otherwise fall back to the `X-User-Id` header
    (frontend-supplied bucket before sign-in), then a shared anonymous bucket.
    Never raises — these endpoints must work signed-out.
    """
    token = _bearer(authorization)
    claims = decode_access_token(token, settings.jwt_secret) if token else None
    if claims is not None:
        return claims["sub"]
    return x_user_id or "anonymous"


OptionalUserId = Annotated[str, Depends(optional_user_id)]


async def optional_user(
    db: DbSession,
    settings: SettingsDep,
    auth: Auth,
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    """Resolve the caller if they present a valid token, else None.

    Used by endpoints reachable both signed-in and via a share link; the
    permission layer decides what the resulting identity may do.
    """
    token = _bearer(authorization)
    claims = decode_access_token(token, settings.jwt_secret) if token else None
    if claims is None:
        return None
    user = await auth.get_user(db, claims["sub"])
    if user is None or not user.is_active or user.deleted_at is not None:
        return None
    return user


OptionalUser = Annotated[User | None, Depends(optional_user)]


def get_workspace_service(request: Request) -> WorkspaceService:
    return request.app.state.workspace_service


def get_storage_service(request: Request) -> StorageService:
    return request.app.state.storage_service


Workspaces = Annotated[WorkspaceService, Depends(get_workspace_service)]
Storage = Annotated[StorageService, Depends(get_storage_service)]
