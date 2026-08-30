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

from ..core.config import Settings
from . import llm
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
        self.client = llm.build_client(settings.active_gemini_api_key)

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
        session.messages.append(llm.user_text(content))
        async for event in self._run_loop(session, user_id):
            yield event

    async def submit_tool_results(
        self, session_id: str, results: list[ClientToolResult], user_id: str
    ) -> AsyncIterator[dict]:
        session = self.sessions.get(session_id, user_id)
        if not session.awaiting_tools:
            raise NotAwaitingToolsError(session_id)

        returned = {r.tool_use_id for r in results}
        if returned != set(session.pending_calls):
            raise NotAwaitingToolsError(
                f"expected results for {sorted(session.pending_calls)}, got {sorted(returned)}"
            )

        cap = self.settings.ai_chat_tool_result_max_chars
        client_parts = [
            _tool_response_part(r, session.pending_calls[r.tool_use_id], cap) for r in results
        ]
        # Server-resolved failures (invalid SQL, never sent to the browser) and
        # the browser's own results are one user turn: Gemini expects every
        # function_call in the preceding model turn to be answered together.
        session.messages.append(
            {"role": llm.ROLE_USER, "parts": session.partial_results + client_parts}
        )
        session.pending_calls = {}
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

                message: dict = {}
                text = ""
                tool_uses: list[dict] = []
                usage = {"input_tokens": 0, "output_tokens": 0}
                async for event in self._call_model(session, force_wrap):
                    if event["type"] == "delta":
                        yield event
                    else:
                        message = event["message"]
                        text = event["text"]
                        tool_uses = event["calls"]
                        usage = event["usage"]

                session.messages.append(message)
                session.tokens_used += usage["input_tokens"] + usage["output_tokens"]
                self.budget.record(user_id, usage["input_tokens"] + usage["output_tokens"])

                if text:
                    yield {"type": "message", "text": text}
                if not tool_uses:
                    session.tool_calls_this_turn = 0
                    yield {"type": "done", "usage": usage}
                    return

                session.tool_calls_this_turn += len(tool_uses)
                client_calls, server_results = self._triage(tool_uses, session)

                if not client_calls:
                    # Every call was resolved server-side (invalid SQL): feed the
                    # errors back and let the model self-correct without the client.
                    session.messages.append(
                        {"role": llm.ROLE_USER, "parts": server_results}
                    )
                    continue

                session.pending_calls = {tu["id"]: tu["name"] for tu in client_calls}
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
        except llm.APIError as e:
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
                    _error_result(
                        tu["id"], tu["name"], validation.result.error or "invalid tool call"
                    )
                )
                continue
            if validation.created_table and validation.created_table not in session.known_tables:
                session.known_tables.append(validation.created_table)
            client_calls.append(tu)
        return client_calls, server_results

    # -- model seam (mocked in tests) ----------------------------------------

    async def _call_model(self, session: ChatSession, force_wrap: bool) -> AsyncIterator[dict]:
        """Yield delta events, then one normalised final event.

        The final event is `{"type": "final", "message", "text", "calls",
        "usage"}` — `message` being the assistant turn to append verbatim, and
        `calls` the function calls in `{id, name, input}` form. Keeping that
        shape provider-neutral is what lets the loop above, and the tests that
        script this method, stay unaware of which model is behind it.
        """
        stream = await self.client.aio.models.generate_content_stream(
            model=self.settings.ai_model,
            contents=session.messages,
            config=llm.generation_config(
                system_instruction=CHAT_SYSTEM_PROMPT,
                max_output_tokens=self.settings.ai_chat_max_tokens,
                effort=self.settings.ai_effort,
                tools=None if force_wrap else CHAT_TOOLS,
                force_no_tools=force_wrap,
            ),
        )

        # Chunks are accumulated rather than handled one at a time: a function
        # call can arrive split across chunks, and only the last chunk carries
        # the usage totals for the turn.
        parts: list[dict] = []
        calls: list[dict] = []
        text_parts: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0}

        async for chunk in stream:
            delta = llm.text_of(chunk)
            if delta:
                text_parts.append(delta)
                yield {"type": "delta", "text": delta}
            chunk_message = llm.model_parts(chunk)
            parts.extend(chunk_message["parts"])
            calls.extend(llm.function_calls_of(chunk))
            chunk_usage = llm.usage_of(chunk)
            if chunk_usage["input_tokens"] or chunk_usage["output_tokens"]:
                usage = chunk_usage

        yield {
            "type": "final",
            "message": {"role": llm.ROLE_MODEL, "parts": parts},
            "text": "".join(text_parts).strip(),
            "calls": calls,
            "usage": usage,
        }


def _tool_response_part(result: ClientToolResult, name: str, max_chars: int) -> dict:
    """One browser result, as the function_response part Gemini expects.

    Truncation happens on the serialised text and is announced in-band: a
    silently cut result reads to the model as the complete answer, which is how
    an agent confidently reports a total that is simply wrong.
    """
    if isinstance(result.content, str):
        text = result.content
    else:
        text = json.dumps(result.content, default=str)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n… [result truncated]"

    payload: dict = {"error": text} if result.is_error else {"result": text}
    return llm.function_response_part(result.tool_use_id, name, payload)


def _error_result(tool_use_id: str, name: str, message: str) -> dict:
    """A failure resolved server-side, fed back without a browser round trip."""
    return llm.function_response_part(tool_use_id, name, {"error": f"Error: {message}"})


def _error(code: str, message: str) -> dict:
    return {"type": "error", "code": code, "message": message}


def _api_error(e: Exception) -> dict:
    return llm.error_event(e)
