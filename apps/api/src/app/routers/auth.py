from fastapi import APIRouter, Request, Response

from ..core.config import Settings
from ..core.deps import Auth, DbSession, SettingsDep
from ..core.ratelimit import rate_limit
from ..schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    MessageResponse,
    ResetPasswordRequest,
    SignupRequest,
    TokenResponse,
    UserResponse,
    VerifyEmailRequest,
)
from ..services.auth_service import IssuedTokens
from ..services.errors import InvalidToken
from .users import to_user_response

router = APIRouter(prefix="/auth", tags=["auth"])

_AUTH_LIMIT = rate_limit("auth", auth=True)


def _set_refresh_cookie(
    response: Response, settings: Settings, tokens: IssuedTokens
) -> None:
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


def _token_response(settings: Settings, tokens: IssuedTokens) -> TokenResponse:
    return TokenResponse(
        access_token=tokens.access_token, expires_in=settings.access_token_ttl_seconds
    )


@router.post(
    "/signup", response_model=UserResponse, status_code=201, operation_id="signup",
    dependencies=[_AUTH_LIMIT],
)
async def signup(
    body: SignupRequest, db: DbSession, auth: Auth, settings: SettingsDep
) -> UserResponse:
    user = await auth.signup(db, body.email, body.password)
    return to_user_response(user)


@router.post("/verify-email", response_model=UserResponse, operation_id="verifyEmail")
async def verify_email(body: VerifyEmailRequest, db: DbSession, auth: Auth) -> UserResponse:
    user = await auth.verify_email(db, body.token)
    return to_user_response(user)


@router.post(
    "/login", response_model=TokenResponse, operation_id="login", dependencies=[_AUTH_LIMIT]
)
async def login(
    body: LoginRequest, response: Response, db: DbSession, auth: Auth, settings: SettingsDep
) -> TokenResponse:
    _, tokens = await auth.login(db, body.email, body.password)
    _set_refresh_cookie(response, settings, tokens)
    return _token_response(settings, tokens)


@router.post("/refresh", response_model=TokenResponse, operation_id="refresh")
async def refresh(
    request: Request, response: Response, db: DbSession, auth: Auth, settings: SettingsDep
) -> TokenResponse:
    raw = request.cookies.get(settings.refresh_cookie_name)
    if not raw:
        raise InvalidToken()
    _, tokens = await auth.rotate_refresh_token(db, raw)
    _set_refresh_cookie(response, settings, tokens)
    return _token_response(settings, tokens)


@router.post("/logout", response_model=MessageResponse, operation_id="logout")
async def logout(
    request: Request, response: Response, db: DbSession, auth: Auth, settings: SettingsDep
) -> MessageResponse:
    await auth.logout(db, request.cookies.get(settings.refresh_cookie_name))
    response.delete_cookie(settings.refresh_cookie_name, path="/api/v1/auth")
    return MessageResponse(message="Logged out.")


@router.post(
    "/password/forgot", response_model=MessageResponse, operation_id="forgotPassword",
    dependencies=[_AUTH_LIMIT],
)
async def forgot_password(
    body: ForgotPasswordRequest, db: DbSession, auth: Auth
) -> MessageResponse:
    await auth.request_password_reset(db, body.email)
    # Same response whether or not the email exists.
    return MessageResponse(message="If that email is registered, a reset link is on its way.")


@router.post("/password/reset", response_model=MessageResponse, operation_id="resetPassword")
async def reset_password(
    body: ResetPasswordRequest, db: DbSession, auth: Auth
) -> MessageResponse:
    await auth.reset_password(db, body.token, body.password)
    return MessageResponse(message="Password updated. Sign in with your new password.")
