"""The versioned chart-spec format (shared with Frontend Phase 3).

A chart spec owns a SQL query; the browser executes it and feeds the result to
the renderer. `extra="forbid"` everywhere so specs double as strict structured-
output schemas for the model.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .validator import ValidationResult, validate_sql

ChartType = Literal[
    "bar", "line", "area", "scatter", "pie", "histogram", "big_number", "table"
]


class ChartEncodings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: str | None = None
    y: str | None = None
    series: str | None = None


class ChartOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x_label: str | None = None
    y_label: str | None = None
    number_format: str | None = None
    stacked: bool | None = None


class ChartSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    type: ChartType
    title: str
    query: str
    encodings: ChartEncodings
    options: ChartOptions = ChartOptions()


def validate_chart_spec(spec: ChartSpec, known_tables: list[str]) -> ValidationResult:
    return validate_sql(spec.query, known_tables)
