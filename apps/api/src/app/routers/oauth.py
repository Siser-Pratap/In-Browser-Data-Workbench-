"""OAuth sign-in routes (Google, GitHub).

Registered only for providers with configured credentials. The redirect and
token exchange run through authlib; the resulting identity is resolved to a
workbench user via OAuthService.link_or_create, then our own tokens are issued.
"""

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import RedirectResponse

from ..core.config import Settings
from ..core.deps import DbSession, SettingsDep
from ..services.oauth_service import OAuthService, configured_providers

router = APIRouter(prefix="/auth/oauth", tags=["auth"])


def build_oauth(settings: Settings) -> OAuth:
    oauth = OAuth()
    for name, config in configured_providers(settings).items():
        oauth.register(name=name, **config)
    return oauth


def _get_oauth(request: Request) -> OAuth:
    oauth = getattr(request.app.state, "oauth", None)
    if oauth is None:
        raise HTTPException(status_code=404, detail="OAuth is not configured.")
    return oauth


async def _fetch_identity(provider: str, client, token) -> tuple[str, str | None]:
    """Return (provider_account_id, email) for the signed-in user."""
    if provider == "google":
        info = token.get("userinfo") or await client.userinfo(token=token)
        return str(info["sub"]), info.get("email")
    # GitHub: the user endpoint may omit a private email; fall back to /user/emails.
    resp = await client.get("user", token=token)
    profile = resp.json()
    email = profile.get("email")
    if not email:
        emails = (await client.get("user/emails", token=token)).json()
        primary = next((e for e in emails if e.get("primary") and e.get("verified")), None)
        email = primary["email"] if primary else None
    return str(profile["id"]), email


@router.get("/{provider}", operation_id="oauthAuthorize")
async def oauth_authorize(provider: str, request: Request, settings: SettingsDep):
    oauth = _get_oauth(request)
    client = oauth.create_client(provider)
    if client is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider}")
    redirect_uri = f"{settings.oauth_redirect_base}/api/v1/auth/oauth/{provider}/callback"
    return await client.authorize_redirect(request, redirect_uri)


@router.get("/{provider}/callback", operation_id="oauthCallback")
async def oauth_callback(provider: str, request: Request, db: DbSession, settings: SettingsDep):
    oauth = _get_oauth(request)
    client = oauth.create_client(provider)
    if client is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider}")

    token = await client.authorize_access_token(request)
    account_id, email = await _fetch_identity(provider, client, token)

    service: OAuthService = request.app.state.oauth_service
    auth = request.app.state.auth_service
    user = await service.link_or_create(db, provider, account_id, email)
    tokens = await auth.issue_tokens(db, user)

    # Hand off to the frontend; the refresh token rides in an httpOnly cookie.
    response = RedirectResponse(url=f"{settings.frontend_base_url}/auth/callback", status_code=303)
    response.set_cookie(
        settings.refresh_cookie_name,
        tokens.refresh_token,
        max_age=settings.refresh_token_ttl_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path="/api/v1/auth",
    )
    return response
