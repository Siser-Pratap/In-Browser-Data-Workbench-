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

from collections.abc import AsyncIterator, Callable

import anthropic
from pydantic import BaseModel, ValidationError

from ..core.config import Settings
from .budget import TokenBudget
from .chartspec import validate_chart_spec
from .parsing import parse_response
from .prompts import (
    CHARTS_SYSTEM_PROMPT,
    CLEAN_SYSTEM_PROMPT,
    CORRECTION_TEMPLATE,
    EXPLAIN_SYSTEM_PROMPT,
    FIX_SYSTEM_PROMPT,
    INSIGHTS_SYSTEM_PROMPT,
    REPAIR_TEMPLATE,
    SQL_SYSTEM_PROMPT,
)
from .schemas import (
    ChartSuggestRequest,
    ChartSuggestResponse,
    CleanRequest,
    CleanResponse,
    InsightsRequest,
    InsightsResponse,
    SqlExplainRequest,
    SqlFixRequest,
    SqlGenerateRequest,
    TableSchema,
)
from .serializer import serialize_tables
from .structured import to_output_schema
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

    # -- Phase 2: profiling-driven endpoints ----------------------------------

    async def stream_clean(self, request: CleanRequest, user_id: str) -> AsyncIterator[dict]:
        tables = [request.profile.table]

        def validate(parsed: CleanResponse) -> tuple[list, list[str]]:
            valid, errors = [], []
            for s in parsed.suggestions:
                result = validate_sql(s.sql, tables, allow_ctas=True)
                if not result.ok:
                    errors.append(f"suggestion '{s.id}' sql: {result.error}")
                    continue
                if s.preview_sql:
                    preview = validate_sql(s.preview_sql, tables)
                    if not preview.ok:
                        errors.append(f"suggestion '{s.id}' preview_sql: {preview.error}")
                        continue
                valid.append(s)
            return valid, errors

        user_message = f"Profile document:\n{request.profile.prompt_json()}"
        async for event in self._structured_pipeline(
            CLEAN_SYSTEM_PROMPT, user_message, CleanResponse, validate, "suggestions", user_id
        ):
            yield event

    async def stream_insights(
        self, request: InsightsRequest, user_id: str
    ) -> AsyncIterator[dict]:
        tables = [request.profile.table]

        def validate(parsed: InsightsResponse) -> tuple[list, list[str]]:
            valid, errors = [], []
            for i, insight in enumerate(parsed.insights):
                result = validate_sql(insight.verification_sql, tables)
                if not result.ok:
                    errors.append(f"insight {i} verification_sql: {result.error}")
                    continue
                if insight.chart_spec is not None:
                    chart = validate_chart_spec(insight.chart_spec, tables)
                    if not chart.ok:
                        errors.append(f"insight {i} chart_spec.query: {chart.error}")
                        continue
                valid.append(insight)
            return valid, errors

        parts = [f"Profile document:\n{request.profile.prompt_json()}"]
        if request.focus:
            parts.append(f"User focus: {request.focus}")
        async for event in self._structured_pipeline(
            INSIGHTS_SYSTEM_PROMPT, "\n\n".join(parts), InsightsResponse, validate,
            "insights", user_id,
        ):
            yield event

    async def stream_charts(
        self, request: ChartSuggestRequest, user_id: str
    ) -> AsyncIterator[dict]:
        tables = [request.profile.table]

        def validate(parsed: ChartSuggestResponse) -> tuple[list, list[str]]:
            valid, errors = [], []
            for i, chart in enumerate(parsed.charts):
                result = validate_chart_spec(chart.spec, tables)
                if result.ok:
                    valid.append(chart)
                else:
                    errors.append(f"chart {i} ({chart.spec.title!r}) query: {result.error}")
            return valid[:4], errors

        parts = [f"Profile document:\n{request.profile.prompt_json()}"]
        if request.question:
            parts.append(f"User question: {request.question}")
        async for event in self._structured_pipeline(
            CHARTS_SYSTEM_PROMPT, "\n\n".join(parts), ChartSuggestResponse, validate,
            "charts", user_id,
        ):
            yield event

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

    async def _structured_pipeline(
        self,
        system: str,
        user_message: str,
        response_model: type[BaseModel],
        validate_items: Callable[[BaseModel], tuple[list, list[str]]],
        event_type: str,
        user_id: str,
    ) -> AsyncIterator[dict]:
        """Structured-output generation -> parse -> per-item SQL validation.

        Structural validity is guaranteed by the output schema; the remaining
        risk is bad SQL inside items. Invalid items trigger one repair round
        (errors fed back), then anything still invalid is dropped and counted.
        """
        schema = to_output_schema(response_model)
        text_parts: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0}
        try:
            async for event in self._stream_model(
                system, user_message, user_id, output_schema=schema
            ):
                if event["type"] == "delta":
                    text_parts.append(event["text"])
                else:
                    usage = event["usage"]

            try:
                parsed = response_model.model_validate_json("".join(text_parts))
            except ValidationError:
                yield {
                    "type": "error",
                    "code": "invalid_output",
                    "message": "The model returned malformed output.",
                }
                yield {"type": "done", "usage": usage}
                return

            valid, errors = validate_items(parsed)
            dropped = 0
            if errors:
                repaired, repair_usage = await self._repair(
                    system, user_message, "".join(text_parts), errors, schema, user_id
                )
                usage = _add_usage(usage, repair_usage)
                if repaired is not None:
                    try:
                        parsed = response_model.model_validate_json(repaired)
                        valid, errors = validate_items(parsed)
                    except ValidationError:
                        pass  # keep the first pass's valid items
                dropped = len(errors)

            yield {
                "type": event_type,
                event_type: [item.model_dump() for item in valid],
                "dropped": dropped,
            }
            yield {"type": "done", "usage": usage}
        except anthropic.APIError as e:
            yield _api_error(e)

    async def _repair(
        self,
        system: str,
        user_message: str,
        previous_json: str,
        errors: list[str],
        output_schema: dict,
        user_id: str,
    ) -> tuple[str | None, dict]:
        self.budget.check(user_id)
        response = await self.client.messages.create(
            model=self.settings.ai_model,
            max_tokens=self.settings.ai_structured_max_tokens,
            thinking={"type": "adaptive"},
            output_config=self._output_config(output_schema),
            system=[
                {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
            ],
            messages=[
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": previous_json},
                {
                    "role": "user",
                    "content": REPAIR_TEMPLATE.format(
                        errors="\n".join(f"- {e}" for e in errors)
                    ),
                },
            ],
        )
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }
        self.budget.record(user_id, usage["input_tokens"] + usage["output_tokens"])
        text = "".join(block.text for block in response.content if block.type == "text")
        return (text or None), usage

    def _output_config(self, output_schema: dict | None) -> dict:
        config: dict = {"effort": self.settings.ai_effort}
        if output_schema is not None:
            config["format"] = {"type": "json_schema", "schema": output_schema}
        return config

    async def _stream_model(
        self,
        system: str,
        user_message: str,
        user_id: str,
        output_schema: dict | None = None,
    ) -> AsyncIterator[dict]:
        """Yields delta events, then a final {"type": "usage"} event."""
        self.budget.check(user_id)
        max_tokens = (
            self.settings.ai_structured_max_tokens
            if output_schema is not None
            else self.settings.ai_max_tokens
        )
        async with self.client.messages.stream(
            model=self.settings.ai_model,
            max_tokens=max_tokens,
            thinking={"type": "adaptive"},
            output_config=self._output_config(output_schema),
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
