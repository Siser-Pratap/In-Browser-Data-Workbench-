import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..core.config import Settings
from .budget import BudgetExceededError
from .schemas import (
    ChartSuggestRequest,
    CleanRequest,
    InsightsRequest,
    SqlExplainRequest,
    SqlFixRequest,
    SqlGenerateRequest,
)
from .service import AIService

router = APIRouter(prefix="/ai", tags=["ai"])


def get_service(request: Request) -> AIService:
    return request.app.state.ai_service


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


# Placeholder identity until Backend Phase 1 auth lands: budgets are keyed by an
# X-User-Id header the frontend sends, falling back to a shared anonymous bucket.
UserId = Annotated[str, Header(alias="X-User-Id")]
Service = Annotated[AIService, Depends(get_service)]


def _sse(events: AsyncIterator[dict]) -> AsyncIterator[str]:
    async def generate() -> AsyncIterator[str]:
        async for event in events:
            yield f"data: {json.dumps(event)}\n\n"

    return generate()


def _check_budget(service: AIService, settings: Settings, user_id: str) -> None:
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="AI is not configured on this server.")
    try:
        service.budget.check(user_id)
    except BudgetExceededError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e


def _stream(events: AsyncIterator[dict]) -> StreamingResponse:
    return StreamingResponse(
        _sse(events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/sql")
async def generate_sql(
    body: SqlGenerateRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: UserId = "anonymous",
) -> StreamingResponse:
    """Translate an English question into a validated DuckDB SQL proposal (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_sql(body, user_id))


@router.post("/sql/fix")
async def fix_sql(
    body: SqlFixRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: UserId = "anonymous",
) -> StreamingResponse:
    """Repair a failing DuckDB query given its error message (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_fix(body, user_id))


@router.post("/sql/explain")
async def explain_sql(
    body: SqlExplainRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: UserId = "anonymous",
) -> StreamingResponse:
    """Explain a SQL query in plain English (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_explain(body, user_id))


@router.post("/clean")
async def suggest_cleaning(
    body: CleanRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: UserId = "anonymous",
) -> StreamingResponse:
    """Profile document in -> validated cleaning suggestions out (SSE).

    Each suggestion's `sql` materializes a NEW table (CREATE TABLE ... AS);
    the original data is never mutated. Applying is always user-initiated.
    """
    _check_budget(service, settings, user_id)
    return _stream(service.stream_clean(body, user_id))


@router.post("/insights")
async def suggest_insights(
    body: InsightsRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: UserId = "anonymous",
) -> StreamingResponse:
    """Profile document in -> ranked insights out (SSE).

    Every insight carries `verification_sql`; the client executes it locally
    and only displays insights whose numbers check out.
    """
    _check_budget(service, settings, user_id)
    return _stream(service.stream_insights(body, user_id))


@router.post("/charts/suggest")
async def suggest_charts(
    body: ChartSuggestRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: UserId = "anonymous",
) -> StreamingResponse:
    """Profile document (+ optional question) -> 2-4 chart specs out (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_charts(body, user_id))
