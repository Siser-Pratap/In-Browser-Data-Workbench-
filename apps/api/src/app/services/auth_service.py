"""Authentication use cases: signup, verify, login, token rotation, reset, delete.

The service owns the security-sensitive logic; routers stay thin. All methods
take an AsyncSession and commit their own unit of work.
"""

import datetime as dt
import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import Settings
from ..core.security import (
    create_access_token,
    create_signed_token,
    hash_password,
    hash_token,
    new_refresh_token,
    password_fingerprint,
    verify_password,
    verify_signed_token,
)
from ..db.models import OAuthAccount, RefreshToken, User
from .email_service import EmailService
from .errors import (
    AccountInactive,
    EmailAlreadyRegistered,
    InvalidCredentials,
    InvalidToken,
    TokenReused,
)


class IssuedTokens:
    def __init__(self, access_token: str, refresh_token: str, refresh_expires_at: dt.datetime):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.refresh_expires_at = refresh_expires_at


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _aware(value: dt.datetime) -> dt.datetime:
    # SQLite returns naive datetimes even for timezone-aware columns; treat
    # stored timestamps as UTC so comparisons work on both SQLite and Postgres.
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.UTC)


class AuthService:
    def __init__(self, settings: Settings, email: EmailService) -> None:
        self.settings = settings
        self.email = email

    # -- signup / verify -----------------------------------------------------

    async def signup(self, db: AsyncSession, email: str, password: str) -> User:
        email = email.strip().lower()
        existing = await self._get_by_email(db, email)
        if existing is not None:
            raise EmailAlreadyRegistered()
        user = User(email=email, password_hash=hash_password(password))
        db.add(user)
        await db.commit()
        await db.refresh(user)
        self.email.send_verification(user.email, self._verification_token(user))
        return user

    def _verification_token(self, user: User) -> str:
        return create_signed_token(
            "verify_email", str(user.id), self.settings.jwt_secret,
            self.settings.email_verification_ttl_seconds,
        )

    async def verify_email(self, db: AsyncSession, token: str) -> User:
        claims = verify_signed_token("verify_email", token, self.settings.jwt_secret)
        if claims is None:
            raise InvalidToken()
        user = await self._get_active(db, claims["sub"])
        user.is_verified = True
        await db.commit()
        await db.refresh(user)
        return user

    # -- login / tokens ------------------------------------------------------

    async def login(self, db: AsyncSession, email: str, password: str) -> tuple[User, IssuedTokens]:
        user = await self._get_by_email(db, email.strip().lower())
        # Constant-ish work whether or not the user exists — verify against the
        # provided hash or a throwaway one, then reject uniformly.
        if user is None or user.password_hash is None:
            verify_password(password, _DUMMY_HASH)
            raise InvalidCredentials()
        if not verify_password(password, user.password_hash):
            raise InvalidCredentials()
        if not user.is_active or user.deleted_at is not None:
            raise AccountInactive()
        tokens = await self._issue_tokens(db, user, family_id=uuid.uuid4())
        return user, tokens

    async def issue_tokens(self, db: AsyncSession, user: User) -> IssuedTokens:
        """Start a fresh token family for a user (used by the OAuth callback)."""
        return await self._issue_tokens(db, user, family_id=uuid.uuid4())

    async def _issue_tokens(
        self, db: AsyncSession, user: User, family_id: uuid.UUID
    ) -> IssuedTokens:
        raw, token_hash = new_refresh_token()
        expires_at = _now() + dt.timedelta(seconds=self.settings.refresh_token_ttl_seconds)
        db.add(
            RefreshToken(
                user_id=user.id, family_id=family_id, token_hash=token_hash, expires_at=expires_at
            )
        )
        await db.commit()
        access = create_access_token(
            str(user.id), self.settings.jwt_secret, self.settings.access_token_ttl_seconds
        )
        return IssuedTokens(access, raw, expires_at)

    async def rotate_refresh_token(self, db: AsyncSession, raw: str) -> tuple[User, IssuedTokens]:
        token = (
            await db.execute(
                select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw))
            )
        ).scalar_one_or_none()

        if token is None or token.revoked or _aware(token.expires_at) < _now():
            raise InvalidToken()
        if token.used_at is not None:
            # Reuse of an already-rotated token → the family is compromised.
            await self._revoke_family(db, token.family_id)
            await db.commit()
            raise TokenReused()

        user = await self._get_active(db, str(token.user_id))
        token.used_at = _now()
        return user, await self._issue_tokens(db, user, family_id=token.family_id)

    async def logout(self, db: AsyncSession, raw: str | None) -> None:
        if not raw:
            return
        token = (
            await db.execute(
                select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw))
            )
        ).scalar_one_or_none()
        if token is not None:
            await self._revoke_family(db, token.family_id)
            await db.commit()

    async def _revoke_family(self, db: AsyncSession, family_id: uuid.UUID) -> None:
        for token in (
            await db.execute(select(RefreshToken).where(RefreshToken.family_id == family_id))
        ).scalars():
            token.revoked = True

    # -- password reset ------------------------------------------------------

    async def request_password_reset(self, db: AsyncSession, email: str) -> None:
        user = await self._get_by_email(db, email.strip().lower())
        # Always succeed to avoid leaking which emails are registered.
        if user is None or user.deleted_at is not None:
            return
        token = create_signed_token(
            "password_reset", str(user.id), self.settings.jwt_secret,
            self.settings.password_reset_ttl_seconds,
            fingerprint=password_fingerprint(user.password_hash),
        )
        self.email.send_password_reset(user.email, token)

    async def reset_password(self, db: AsyncSession, token: str, new_password: str) -> None:
        claims = verify_signed_token("password_reset", token, self.settings.jwt_secret)
        if claims is None:
            raise InvalidToken()
        user = await self._get_active(db, claims["sub"])
        # The token is bound to the password it was minted for — a used token
        # (password already changed) no longer matches.
        if claims.get("fp") != password_fingerprint(user.password_hash):
            raise InvalidToken()
        user.password_hash = hash_password(new_password)
        await self._revoke_all_user_tokens(db, user.id)
        await db.commit()

    async def _revoke_all_user_tokens(self, db: AsyncSession, user_id: uuid.UUID) -> None:
        for token in (
            await db.execute(select(RefreshToken).where(RefreshToken.user_id == user_id))
        ).scalars():
            token.revoked = True

    # -- account deletion ----------------------------------------------------

    async def delete_user(self, db: AsyncSession, user: User) -> None:
        """Real deletion: cascade the user's tokens and OAuth links, then the row."""
        await db.execute(delete(RefreshToken).where(RefreshToken.user_id == user.id))
        await db.execute(delete(OAuthAccount).where(OAuthAccount.user_id == user.id))
        await db.delete(user)
        await db.commit()

    # -- lookups -------------------------------------------------------------

    async def _get_by_email(self, db: AsyncSession, email: str) -> User | None:
        return (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()

    async def get_user(self, db: AsyncSession, user_id: str) -> User | None:
        try:
            uid = uuid.UUID(user_id)
        except (ValueError, TypeError):
            return None
        return (await db.execute(select(User).where(User.id == uid))).scalar_one_or_none()

    async def _get_active(self, db: AsyncSession, user_id: str) -> User:
        user = await self.get_user(db, user_id)
        if user is None:
            raise InvalidToken()
        if not user.is_active or user.deleted_at is not None:
            raise AccountInactive()
        return user


# A valid argon2 hash of a random string, so login timing doesn't reveal whether
# an email exists.
_DUMMY_HASH = hash_password("unused-timing-equalizer")
