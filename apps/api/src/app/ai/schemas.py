from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .chartspec import ChartSpec
from .profile import TableProfile


class ColumnSchema(BaseModel):
    name: str
    type: str


class TableSchema(BaseModel):
    name: str
    columns: list[ColumnSchema]
    row_count: int | None = None
    # Sample values are opt-in from the client — the server never sees user data
    # unless the browser explicitly includes it here.
    samples: dict[str, list[str]] | None = None
    column_stats: dict[str, dict[str, Any]] | None = None


class SqlGenerateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    tables: list[TableSchema] = Field(min_length=1)
    dialect: Literal["duckdb"] = "duckdb"


class SqlFixRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=20_000)
    error: str = Field(min_length=1, max_length=4000)
    tables: list[TableSchema] = Field(min_length=1)
    dialect: Literal["duckdb"] = "duckdb"


class SqlExplainRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=20_000)
    tables: list[TableSchema] = Field(default_factory=list)
    dialect: Literal["duckdb"] = "duckdb"


# -- Phase 2: profiling-driven endpoints --------------------------------------


class CleanRequest(BaseModel):
    profile: TableProfile


class InsightsRequest(BaseModel):
    profile: TableProfile
    focus: str | None = Field(default=None, max_length=500)


class ChartSuggestRequest(BaseModel):
    profile: TableProfile
    question: str | None = Field(default=None, max_length=500)


# Model-facing output models (used as structured-output schemas, extra="forbid"
# so every object carries additionalProperties: false).


class CleaningSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    severity: Literal["info", "warning", "critical"]
    finding: str
    proposal: str
    # SELECT showing the affected rows — the frontend's "Preview" button.
    preview_sql: str | None
    # CREATE TABLE <new> AS SELECT ... — cleaning materializes, never mutates.
    sql: str
    affects_rows_estimate: int | None


class CleanResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggestions: list[CleaningSuggestion]


class Insight(BaseModel):
    model_config = ConfigDict(extra="forbid")

    headline: str
    detail: str
    # The frontend executes this locally and only displays insights whose
    # numbers check out — the AI never sees the raw data.
    verification_sql: str
    confidence: Literal["verified_by_sql", "hypothesis"]
    chart_spec: ChartSpec | None


class InsightsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    insights: list[Insight]


class SuggestedChart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rationale: str
    spec: ChartSpec


class ChartSuggestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    charts: list[SuggestedChart]
