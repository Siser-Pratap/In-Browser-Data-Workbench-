import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .ai.chat_service import ChatService
from .ai.router import router as ai_router
from .ai.service import AIService
from .core.config import Settings, get_settings
from .core.logging import RequestContextMiddleware, configure_logging
from .core.problem import install_problem_handlers
from .core.ratelimit import RateLimiter
from .db.base import Base
from .db.session import create_database
from .routers.auth import router as auth_router
from .routers.health import router as health_router
from .routers.users import router as users_router
from .services.auth_service import AuthService
from .services.email_service import EmailService
from .services.oauth_service import OAuthService, configured_providers


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging()

    # Never run on a hardcoded signing key; generate one if unset (tokens then
    # don't survive a restart, which is fine for dev/test).
    if not settings.jwt_secret:
        settings.jwt_secret = secrets.token_urlsafe(48)

    database = create_database(settings.database_url, echo=settings.db_echo)
    providers = configured_providers(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.db_auto_create:
            async with database.engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        yield
        await database.dispose()

    app = FastAPI(
        title="In-Browser Data Workbench API",
        version="0.1.0",
        description="Backend for the local-first data workbench. Accounts and workspaces "
        "live here; the AI endpoints translate natural language into DuckDB SQL proposals "
        "that always execute client-side.",
        lifespan=lifespan,
    )

    settings_email = EmailService(settings.frontend_base_url)
    app.state.settings = settings
    app.state.db = database
    app.state.rate_limiter = RateLimiter()
    app.state.email_service = settings_email
    app.state.auth_service = AuthService(settings, settings_email)
    app.state.oauth_service = OAuthService()
    app.state.ai_service = AIService(settings)
    app.state.chat_service = ChatService(settings, app.state.ai_service.budget)

    install_problem_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(users_router, prefix="/api/v1")
    app.include_router(ai_router, prefix="/api/v1")

    if providers:
        # authlib stores the OAuth state/nonce in a signed session cookie.
        from starlette.middleware.sessions import SessionMiddleware

        from .routers.oauth import build_oauth
        from .routers.oauth import router as oauth_router

        app.add_middleware(SessionMiddleware, secret_key=settings.jwt_secret)
        app.state.oauth = build_oauth(settings)
        app.include_router(oauth_router, prefix="/api/v1")

    return app


app = create_app()
