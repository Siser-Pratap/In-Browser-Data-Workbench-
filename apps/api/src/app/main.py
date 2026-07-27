from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .ai.chat_service import ChatService
from .ai.router import router as ai_router
from .ai.service import AIService
from .core.config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="In-Browser Data Workbench API",
        version="0.1.0",
        description="Backend for the local-first data workbench. "
        "AI endpoints translate natural language into DuckDB SQL proposals; "
        "execution always happens client-side.",
    )
    app.state.settings = settings
    app.state.ai_service = AIService(settings)
    # Chat shares the daily token budget with the other AI endpoints.
    app.state.chat_service = ChatService(settings, app.state.ai_service.budget)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(ai_router, prefix="/api/v1")

    @app.get("/healthz", tags=["health"])
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
