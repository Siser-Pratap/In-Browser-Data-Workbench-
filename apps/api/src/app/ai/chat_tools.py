"""Tools the analyst can call. Every tool executes in the BROWSER.

The backend runs the model loop and brokers tool calls; the browser executes
them against DuckDB-WASM and POSTs results back. SQL-bearing tools are validated
server-side *before* the call is sent to the client — invalid SQL is turned into
an error tool result and fed straight back to the model (no client round-trip),
so bad queries never reach the browser.
"""

from dataclasses import dataclass

from .chartspec import ChartSpec, validate_chart_spec
from .structured import to_output_schema
from .validator import ValidationResult, created_table_name, validate_sql

CHAT_TOOLS = [
    {
        "name": "list_tables",
        "description": "List the tables currently loaded in the user's workbench.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_schema",
        "description": "Get the columns and types of one table.",
        "input_schema": {
            "type": "object",
            "properties": {"table": {"type": "string"}},
            "required": ["table"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_profile",
        "description": (
            "Get a data profile for one table: null %, distinct counts, top values, "
            "and numeric/temporal stats. Use it to understand a column before querying."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"table": {"type": "string"}},
            "required": ["table"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_sql",
        "description": (
            "Run a read-only DuckDB query (SELECT, or CREATE TABLE new AS SELECT to "
            "materialize a derived table) against the user's tables and get result "
            "rows. Results are capped to a preview — aggregate or LIMIT for large tables."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"sql": {"type": "string"}},
            "required": ["sql"],
            "additionalProperties": False,
        },
    },
    {
        "name": "create_chart",
        "description": (
            "Render a chart inline in the conversation. Provide a chart spec whose "
            "query aggregates the data to plot (it must return few rows)."
        ),
        "input_schema": to_output_schema(ChartSpec),
    },
    {
        "name": "save_query",
        "description": "Save a useful SQL query to the user's workspace under a name.",
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "sql": {"type": "string"}},
            "required": ["name", "sql"],
            "additionalProperties": False,
        },
    },
]

TOOL_NAMES = {t["name"] for t in CHAT_TOOLS}


@dataclass
class ToolValidation:
    result: ValidationResult
    created_table: str | None = None


def validate_tool_use(name: str, tool_input: dict, known_tables: list[str]) -> ToolValidation:
    """Validate a tool call server-side. Non-SQL tools always pass."""
    if name == "run_sql":
        sql = tool_input.get("sql", "")
        result = validate_sql(sql, known_tables, allow_ctas=True)
        created = created_table_name(sql) if result.ok else None
        return ToolValidation(result, created)

    if name == "save_query":
        result = validate_sql(tool_input.get("sql", ""), known_tables, allow_ctas=True)
        return ToolValidation(result)

    if name == "create_chart":
        try:
            spec = ChartSpec.model_validate(tool_input)
        except Exception as e:  # noqa: BLE001 — surface any spec error back to the model
            return ToolValidation(ValidationResult(ok=False, error=f"Invalid chart spec: {e}"))
        return ToolValidation(validate_chart_spec(spec, known_tables))

    return ToolValidation(ValidationResult(ok=True))
