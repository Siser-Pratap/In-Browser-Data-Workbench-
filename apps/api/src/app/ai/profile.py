"""The versioned profile document contract (AI Phase 2).

The BROWSER computes this profile with DuckDB SQL — raw data stays local; the
AI only ever sees these aggregates (plus top values, which the client can omit).
This schema is the wire contract shared with the frontend profiler.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field


class TopValue(BaseModel):
    value: str
    count: int


class NumericStats(BaseModel):
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    stddev: float | None = None
    p25: float | None = None
    p50: float | None = None
    p75: float | None = None
    zero_pct: float | None = None
    negative_pct: float | None = None


class TemporalStats(BaseModel):
    min: str | None = None
    max: str | None = None


class ColumnProfile(BaseModel):
    name: str
    type: str
    null_pct: float = 0.0
    distinct_count: int | None = None
    distinct_pct: float | None = None
    top_values: list[TopValue] | None = None
    numeric: NumericStats | None = None
    temporal: TemporalStats | None = None
    # Free-form pattern measurements, e.g. {"regex_email_match_pct": 94.5}
    patterns: dict[str, Any] | None = None


class TableProfile(BaseModel):
    version: Literal[1] = 1
    table: str
    row_count: int
    columns: list[ColumnProfile] = Field(min_length=1)
    candidate_keys: list[str] = Field(default_factory=list)
    sample_rows_included: bool = False

    def prompt_json(self) -> str:
        return self.model_dump_json(exclude_none=True)
