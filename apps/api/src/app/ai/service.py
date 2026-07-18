"""NL->SQL service: streams Claude output, validates it, self-corrects once.

Event stream contract (each yielded dict becomes one SSE event):
  {"type": "delta", "text": ...}                 incremental model text
  {"type": "sql", "sql": ..., "explanation": ..., "corrected": bool}
  {"type": "clarification", "question": ...}
  {"type": "explanation", "text": ...}           (explain endpoint only)
  {"type": "error", "code": ..., "message": ...}
  {"type": "done", "usage": {"input_tokens": ..., "output_tokens": ...}}

The returned SQL is a proposal — execution always happens client-side on
explicit user action.
"""

from collections.abc import AsyncIterator

import anthropic

from ..core.config import Settings
from .budget import TokenBudget
from .parsing import parse_response
from .prompts import (
    CORRECTION_TEMPLATE,
    EXPLAIN_SYSTEM_PROMPT,
    FIX_SYSTEM_PROMPT,
    SQL_SYSTEM_PROMPT,
)
from .schemas import SqlExplainRequest, SqlFixRequest, SqlGenerateRequest, TableSchema
from .serializer import serialize_tables
from .validator import validate_sql


class AIService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.budget = TokenBudget(daily_limit=settings.ai_daily_token_budget)
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key or None)

    # -- public entry points -------------------------------------------------

    async def stream_sql(
        self, request: SqlGenerateRequest, user_id: str
    ) -> AsyncIterator[dict]:
        schema_block = self._schema_block(request.tables)
        user_message = f"{schema_block}\n\nQuestion: {request.question}"
        async for event in self._sql_pipeline(
            SQL_SYSTEM_PROMPT, user_message, request.tables, user_id
        ):
            yield event

    async def stream_fix(self, request: SqlFixRequest, user_id: str) -> AsyncIterator[dict]:
        schema_block = self._schema_block(request.tables)
        user_message = (
            f"{schema_block}\n\nFailing query:\n```sql\n{request.sql}\n```\n\n"
            f"DuckDB error:\n{request.error}"
        )
        async for event in self._sql_pipeline(
            FIX_SYSTEM_PROMPT, user_message, request.tables, user_id
        ):
            yield event

    async def stream_explain(
        self, request: SqlExplainRequest, user_id: str
    ) -> AsyncIterator[dict]:
        parts = []
        if request.tables:
            parts.append(self._schema_block(request.tables))
        parts.append(f"Query to explain:\n```sql\n{request.sql}\n```")
        user_message = "\n\n".join(parts)

        text_parts: list[str] = []
        try:
            async for event in self._stream_model(EXPLAIN_SYSTEM_PROMPT, user_message, user_id):
                if event["type"] == "delta":
                    text_parts.append(event["text"])
                    yield event
                else:  # usage
                    yield {"type": "explanation", "text": "".join(text_parts).strip()}
                    yield {"type": "done", "usage": event["usage"]}
        except anthropic.APIError as e:
            yield _api_error(e)

    # -- internals -----------------------------------------------------------

    def _schema_block(self, tables: list[TableSchema]) -> str:
        rendered = serialize_tables(tables, self.settings.ai_schema_context_max_chars)
        return f"Schema of the user's tables:\n\n{rendered}"

    async def _sql_pipeline(
        self,
        system: str,
        user_message: str,
        tables: list[TableSchema],
        user_id: str,
    ) -> AsyncIterator[dict]:
        table_names = [t.name for t in tables]
        text_parts: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0}

        try:
            async for event in self._stream_model(system, user_message, user_id):
                if event["type"] == "delta":
                    text_parts.append(event["text"])
                    yield event
                else:
                    usage = event["usage"]

            parsed = parse_response("".join(text_parts))

            if parsed.clarification:
                yield {"type": "clarification", "question": parsed.clarification}
                yield {"type": "done", "usage": usage}
                return

            if parsed.sql is None:
                yield {
                    "type": "error",
                    "code": "no_sql",
                    "message": "The model did not return a SQL statement.",
                }
                yield {"type": "done", "usage": usage}
                return

            result = validate_sql(parsed.sql, table_names)
            corrected = False
            if not result.ok:
                # One self-correction round: feed the validation error back.
                parsed, correction_usage = await self._correct(
                    system, user_message, "".join(text_parts), result.error or "", user_id
                )
                usage = _add_usage(usage, correction_usage)
                corrected = True
                if parsed.sql is None or not (
                    result := validate_sql(parsed.sql, table_names)
                ).ok:
                    yield {
                        "type": "error",
                        "code": "validation_failed",
                        "message": result.error
                        if parsed.sql is not None
                        else "The model did not return a SQL statement.",
                    }
                    yield {"type": "done", "usage": usage}
                    return

            yield {
                "type": "sql",
                "sql": parsed.sql,
                "explanation": parsed.explanation,
                "corrected": corrected,
            }
            yield {"type": "done", "usage": usage}
        except anthropic.APIError as e:
            yield _api_error(e)

    async def _stream_model(
        self, system: str, user_message: str, user_id: str
    ) -> AsyncIterator[dict]:
        """Yields delta events, then a final {"type": "usage"} event."""
        self.budget.check(user_id)
        async with self.client.messages.stream(
            model=self.settings.ai_model,
            max_tokens=self.settings.ai_max_tokens,
            thinking={"type": "adaptive"},
            output_config={"effort": self.settings.ai_effort},
            # Static system prompt is the stable cacheable prefix; volatile
            # schema + question live in the user message.
            system=[
                {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
            ],
            messages=[{"role": "user", "content": user_message}],
        ) as stream:
            async for text in stream.text_stream:
                yield {"type": "delta", "text": text}
            final = await stream.get_final_message()

        usage = {
            "input_tokens": final.usage.input_tokens,
            "output_tokens": final.usage.output_tokens,
        }
        self.budget.record(user_id, usage["input_tokens"] + usage["output_tokens"])
        yield {"type": "usage", "usage": usage}

    async def _correct(
        self,
        system: str,
        user_message: str,
        previous_answer: str,
        error: str,
        user_id: str,
    ) -> tuple:
        self.budget.check(user_id)
        response = await self.client.messages.create(
            model=self.settings.ai_model,
            max_tokens=self.settings.ai_max_tokens,
            thinking={"type": "adaptive"},
            output_config={"effort": self.settings.ai_effort},
            system=[
                {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
            ],
            messages=[
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": previous_answer},
                {"role": "user", "content": CORRECTION_TEMPLATE.format(error=error)},
            ],
        )
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }
        self.budget.record(user_id, usage["input_tokens"] + usage["output_tokens"])
        text = "".join(block.text for block in response.content if block.type == "text")
        return parse_response(text), usage


def _add_usage(a: dict, b: dict) -> dict:
    return {k: a.get(k, 0) + b.get(k, 0) for k in ("input_tokens", "output_tokens")}


def _api_error(e: anthropic.APIError) -> dict:
    if isinstance(e, anthropic.RateLimitError):
        code = "upstream_rate_limited"
        message = "The AI service is rate-limited; try again shortly."
    elif isinstance(e, anthropic.AuthenticationError):
        code, message = (
            "not_configured",
            "AI is not configured on this server (missing or invalid API key).",
        )
    else:
        code, message = "upstream_error", "The AI service failed to respond."
    return {"type": "error", "code": code, "message": message}
