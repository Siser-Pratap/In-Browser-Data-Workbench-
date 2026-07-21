import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..core.config import Settings
from ..core.deps import OptionalUserId
from ..core.ratelimit import rate_limit
from .budget import BudgetExceededError
from .chat_service import ChatService
from .chat_session import NotAwaitingToolsError, SessionNotFoundError
from .schemas import (
    ChartSuggestRequest,
    ChatCreateRequest,
    ChatCreateResponse,
    ChatMessageRequest,
    ChatToolResultRequest,
    CleanRequest,
    InsightsRequest,
    SqlExplainRequest,
    SqlFixRequest,
    SqlGenerateRequest,
)
from .service import AIService

# The daily token budget caps spend; this caps request rate, which the
# budget alone does not (a rejected or cached call costs no tokens).
router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[rate_limit("ai")])


def get_service(request: Request) -> AIService:
    return request.app.state.ai_service


def get_chat_service(request: Request) -> ChatService:
    return request.app.state.chat_service


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


# Identity for these local-first endpoints: a valid access token wins, else the
# X-User-Id header (frontend bucket before sign-in), else a shared anonymous
# bucket. See core.deps.optional_user_id.
Service = Annotated[AIService, Depends(get_service)]
Chat = Annotated[ChatService, Depends(get_chat_service)]


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


@router.post("/sql", operation_id="generateSql")
async def generate_sql(
    body: SqlGenerateRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Translate an English question into a validated DuckDB SQL proposal (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_sql(body, user_id))


@router.post("/sql/fix", operation_id="fixSql")
async def fix_sql(
    body: SqlFixRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Repair a failing DuckDB query given its error message (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_fix(body, user_id))


@router.post("/sql/explain", operation_id="explainSql")
async def explain_sql(
    body: SqlExplainRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Explain a SQL query in plain English (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_explain(body, user_id))


@router.post("/clean", operation_id="proposeCleaning")
async def suggest_cleaning(
    body: CleanRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Profile document in -> validated cleaning suggestions out (SSE).

    Each suggestion's `sql` materializes a NEW table (CREATE TABLE ... AS);
    the original data is never mutated. Applying is always user-initiated.
    """
    _check_budget(service, settings, user_id)
    return _stream(service.stream_clean(body, user_id))


@router.post("/insights", operation_id="generateInsights")
async def suggest_insights(
    body: InsightsRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Profile document in -> ranked insights out (SSE).

    Every insight carries `verification_sql`; the client executes it locally
    and only displays insights whose numbers check out.
    """
    _check_budget(service, settings, user_id)
    return _stream(service.stream_insights(body, user_id))


@router.post("/charts/suggest", operation_id="suggestCharts")
async def suggest_charts(
    body: ChartSuggestRequest,
    service: Service,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Profile document (+ optional question) -> 2-4 chart specs out (SSE)."""
    _check_budget(service, settings, user_id)
    return _stream(service.stream_charts(body, user_id))


# -- Phase 3: conversational analyst ------------------------------------------


def _require_configured(settings: Settings) -> None:
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="AI is not configured on this server.")


@router.post("/chat", response_model=ChatCreateResponse, operation_id="createChatSession")
async def create_chat(
    body: ChatCreateRequest,
    chat: Chat,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> ChatCreateResponse:
    """Start an analyst chat session bound to the current dataset schemas."""
    _require_configured(settings)
    session_id, starters = chat.create_session(body, user_id)
    return ChatCreateResponse(session_id=session_id, starter_prompts=starters)


@router.post("/chat/{session_id}/message", operation_id="sendChatMessage")
async def chat_message(
    session_id: str,
    body: ChatMessageRequest,
    chat: Chat,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Send a user message; stream assistant text, tool calls, or completion (SSE).

    A turn that emits `tool_call` events ends with `awaiting_tools`: the browser
    executes the tools and POSTs the results to `/chat/{session_id}/tool-result`
    to resume.
    """
    _require_configured(settings)
    try:
        chat.budget.check(user_id)
    except BudgetExceededError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    try:
        chat.sessions.get(session_id, user_id)
    except SessionNotFoundError as e:
        raise HTTPException(status_code=404, detail="Chat session not found.") from e
    return _stream(chat.send_message(session_id, body.content, user_id))


@router.post("/chat/{session_id}/tool-result", operation_id="submitChatToolResult")
async def chat_tool_result(
    session_id: str,
    body: ChatToolResultRequest,
    chat: Chat,
    settings: Annotated[Settings, Depends(get_app_settings)],
    user_id: OptionalUserId,
) -> StreamingResponse:
    """Return browser tool results to resume a paused turn (SSE)."""
    _require_configured(settings)
    try:
        chat.budget.check(user_id)
    except BudgetExceededError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    try:
        chat.sessions.get(session_id, user_id)
    except SessionNotFoundError as e:
        raise HTTPException(status_code=404, detail="Chat session not found.") from e

    async def resume():
        try:
            async for event in chat.submit_tool_results(session_id, body.results, user_id):
                yield event
        except NotAwaitingToolsError:
            yield {
                "type": "error",
                "code": "not_awaiting_tools",
                "message": "This session is not waiting for these tool results.",
            }

    return _stream(resume())
