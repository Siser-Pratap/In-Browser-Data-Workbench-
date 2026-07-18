from typing import Any, Literal

from pydantic import BaseModel, Field


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
