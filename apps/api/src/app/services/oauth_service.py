"""OAuth sign-in: account linking + provider registry.

The linking logic (`link_or_create`) is provider-agnostic and unit-tested. The
authlib-backed registry is built only for providers whose client id/secret are
configured, so the app runs fine with OAuth disabled.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import Settings
from ..db.models import OAuthAccount, User


class OAuthService:
    async def link_or_create(
        self,
        db: AsyncSession,
        provider: str,
        provider_account_id: str,
        email: str | None,
    ) -> User:
        """Resolve an OAuth identity to a workbench user.

        1. Known (provider, account id) -> its user.
        2. Otherwise, an existing user with the same verified email -> link to it.
        3. Otherwise, create a new (already-verified) user and link.
        """
        account = (
            await db.execute(
                select(OAuthAccount).where(
                    OAuthAccount.provider == provider,
                    OAuthAccount.provider_account_id == provider_account_id,
                )
            )
        ).scalar_one_or_none()
        if account is not None:
            return (
                await db.execute(select(User).where(User.id == account.user_id))
            ).scalar_one()

        user: User | None = None
        if email:
            email = email.strip().lower()
            user = (
                await db.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
        if user is None:
            # OAuth-verified email → the account is created verified, with no password.
            user = User(email=email or f"{provider}:{provider_account_id}", is_verified=True)
            db.add(user)
            await db.flush()

        db.add(
            OAuthAccount(
                user_id=user.id,
                provider=provider,
                provider_account_id=provider_account_id,
                email=email,
            )
        )
        await db.commit()
        await db.refresh(user)
        return user


def configured_providers(settings: Settings) -> dict[str, dict]:
    """Provider config for authlib, only for those with credentials present."""
    providers: dict[str, dict] = {}
    if settings.google_client_id and settings.google_client_secret:
        providers["google"] = {
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
            "client_kwargs": {"scope": "openid email profile"},
        }
    if settings.github_client_id and settings.github_client_secret:
        providers["github"] = {
            "client_id": settings.github_client_id,
            "client_secret": settings.github_client_secret,
            "access_token_url": "https://github.com/login/oauth/access_token",
            "authorize_url": "https://github.com/login/oauth/authorize",
            "api_base_url": "https://api.github.com/",
            "client_kwargs": {"scope": "read:user user:email"},
        }
    return providers
