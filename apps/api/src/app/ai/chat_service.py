"""Agentic analyst orchestration (AI Phase 3).

The model loop lives here; tool execution lives in the browser. A turn runs the
model repeatedly until it either finishes (`done`) or emits tool calls the
browser must run — at which point the loop pauses (`awaiting_tools`) and resumes
when the client POSTs results.

Event stream (each dict → one SSE event):
  {"type": "delta", "text": ...}                         assistant text token
  {"type": "message", "text": ...}                       full assistant text of a step
  {"type": "tool_call", "tool_use_id", "name", "input"}  browser must execute this
  {"type": "awaiting_tools"}                              turn paused; run tools + POST results
  {"type": "error", "code", "message"}
  {"type": "done", "usage": {...}}                        turn complete
"""

import json
from collections.abc import AsyncIterator

import anthropic

from ..core.config import Settings
from .budget import TokenBudget
from .chat_prompts import CHAT_SYSTEM_PROMPT, starter_prompts
from .chat_session import (
    ChatSession,
    ChatSessionStore,
    NotAwaitingToolsError,
)
from .chat_tools import CHAT_TOOLS, validate_tool_use
from .schemas import ChatCreateRequest, ClientToolResult


class ChatService:
    def __init__(self, settings: Settings, budget: TokenBudget) -> None:
        self.settings = settings
        self.budget = budget
        self.sessions = ChatSessionStore(ttl_seconds=settings.ai_chat_session_ttl_seconds)
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key or None)

    # -- lifecycle -----------------------------------------------------------

    def create_session(self, request: ChatCreateRequest, user_id: str) -> tuple[str, list[str]]:
        session = self.sessions.create(user_id, request.tables, request.title)
        return session.id, starter_prompts(request.tables)

    async def send_message(
        self, session_id: str, content: str, user_id: str
    ) -> AsyncIterator[dict]:
        session = self.sessions.get(session_id, user_id)
        if session.awaiting_tools:
            yield _error("awaiting_tools", "This turn is waiting for tool results.")
            return
        if session.turns >= self.settings.ai_chat_max_turns:
            yield _error("turn_limit", "This conversation has reached its message limit.")
            return

        session.turns += 1
        session.tool_calls_this_turn = 0
        session.messages.append({"role": "user", "content": content})
        async for event in self._run_loop(session, user_id):
            yield event

    async def submit_tool_results(
        self, session_id: str, results: list[ClientToolResult], user_id: str
    ) -> AsyncIterator[dict]:
        session = self.sessions.get(session_id, user_id)
        if not session.awaiting_tools:
            raise NotAwaitingToolsError(session_id)

        returned = {r.tool_use_id for r in results}
        if returned != set(session.pending_ids):
            raise NotAwaitingToolsError(
                f"expected results for {session.pending_ids}, got {sorted(returned)}"
            )

        cap = self.settings.ai_chat_tool_result_max_chars
        client_blocks = [_tool_result_block(r, cap) for r in results]
        merged = session.partial_results + client_blocks
        session.messages.append({"role": "user", "content": merged})
        session.pending_ids = []
        session.partial_results = []

        async for event in self._run_loop(session, user_id):
            yield event

    # -- the loop ------------------------------------------------------------

    async def _run_loop(self, session: ChatSession, user_id: str) -> AsyncIterator[dict]:
        try:
            while True:
                self.budget.check(user_id)
                # Wrap up when either cap is hit: force a tools-off final answer
                # so the turn always terminates gracefully.
                force_wrap = (
                    session.tool_calls_this_turn >= self.settings.ai_chat_max_tool_calls_per_turn
                    or session.tokens_used >= self.settings.ai_chat_session_token_budget
                )

                content: list[dict] = []
                usage = {"input_tokens": 0, "output_tokens": 0}
                async for event in self._call_model(session, force_wrap):
                    if event["type"] == "delta":
                        yield event
                    else:
                        content, usage = event["content"], event["usage"]

                session.messages.append({"role": "assistant", "content": content})
                session.tokens_used += usage["input_tokens"] + usage["output_tokens"]
                self.budget.record(user_id, usage["input_tokens"] + usage["output_tokens"])

                text = _text_of(content)
                if text:
                    yield {"type": "message", "text": text}

                tool_uses = [b for b in content if b["type"] == "tool_use"]
                if not tool_uses:
                    session.tool_calls_this_turn = 0
                    yield {"type": "done", "usage": usage}
                    return

                session.tool_calls_this_turn += len(tool_uses)
                client_calls, server_results = self._triage(tool_uses, session)

                if not client_calls:
                    # Every call was resolved server-side (invalid SQL): feed the
                    # errors back and let the model self-correct without the client.
                    session.messages.append({"role": "user", "content": server_results})
                    continue

                session.pending_ids = [tu["id"] for tu in client_calls]
                session.partial_results = server_results
                for tu in client_calls:
                    yield {
                        "type": "tool_call",
                        "tool_use_id": tu["id"],
                        "name": tu["name"],
                        "input": tu["input"],
                    }
                yield {"type": "awaiting_tools"}
                return
        except anthropic.APIError as e:
            yield _api_error(e)

    def _triage(
        self, tool_uses: list[dict], session: ChatSession
    ) -> tuple[list[dict], list[dict]]:
        """Split tool calls into client-executed and server-resolved (invalid)."""
        client_calls: list[dict] = []
        server_results: list[dict] = []
        for tu in tool_uses:
            validation = validate_tool_use(tu["name"], tu["input"], session.known_tables)
            if not validation.result.ok:
                server_results.append(
                    _error_result(tu["id"], validation.result.error or "invalid tool call")
                )
                continue
            if validation.created_table and validation.created_table not in session.known_tables:
                session.known_tables.append(validation.created_table)
            client_calls.append(tu)
        return client_calls, server_results

    # -- model seam (mocked in tests) ----------------------------------------

    async def _call_model(self, session: ChatSession, force_wrap: bool) -> AsyncIterator[dict]:
        """Yield delta events, then one {"type":"final","content","usage"} event."""
        kwargs: dict = {}
        if force_wrap:
            kwargs["tool_choice"] = {"type": "none"}
        else:
            kwargs["tools"] = CHAT_TOOLS

        async with self.client.messages.stream(
            model=self.settings.ai_model,
            max_tokens=self.settings.ai_chat_max_tokens,
            thinking={"type": "adaptive"},
            output_config={"effort": self.settings.ai_effort},
            system=[
                {"type": "text", "text": CHAT_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
            ],
            messages=session.messages,
            **kwargs,
        ) as stream:
            async for text in stream.text_stream:
                yield {"type": "delta", "text": text}
            final = await stream.get_final_message()

        yield {
            "type": "final",
            "content": [block.model_dump() for block in final.content],
            "usage": {
                "input_tokens": final.usage.input_tokens,
                "output_tokens": final.usage.output_tokens,
            },
        }


def _text_of(content: list[dict]) -> str:
    return "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()


def _tool_result_block(result: ClientToolResult, max_chars: int) -> dict:
    if isinstance(result.content, str):
        text = result.content
    else:
        text = json.dumps(result.content, default=str)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n… [result truncated]"
    return {
        "type": "tool_result",
        "tool_use_id": result.tool_use_id,
        "content": text,
        "is_error": result.is_error,
    }


def _error_result(tool_use_id: str, message: str) -> dict:
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": f"Error: {message}",
        "is_error": True,
    }


def _error(code: str, message: str) -> dict:
    return {"type": "error", "code": code, "message": message}


def _api_error(e: anthropic.APIError) -> dict:
    if isinstance(e, anthropic.RateLimitError):
        return _error("upstream_rate_limited", "The AI service is rate-limited; try again shortly.")
    if isinstance(e, anthropic.AuthenticationError):
        return _error("not_configured", "AI is not configured on this server.")
    return _error("upstream_error", "The AI service failed to respond.")
