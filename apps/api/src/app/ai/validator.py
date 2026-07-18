"""Validate model-generated SQL before it is returned to the client.

Three gates, all mechanical:
1. It parses as exactly one DuckDB statement.
2. The statement is read-only (SELECT / set operations, optionally CTE-wrapped).
3. Every referenced table exists in the schema context the client sent.

Execution always happens client-side in the browser, so this is a quality
filter more than a security boundary — but it catches most bad generations
before the user ever sees them.
"""

from dataclasses import dataclass

import sqlglot
from sqlglot import exp

_READ_ONLY_ROOTS = (exp.Select, exp.Union, exp.Intersect, exp.Except)


@dataclass
class ValidationResult:
    ok: bool
    error: str | None = None


def validate_sql(sql: str, known_tables: list[str]) -> ValidationResult:
    try:
        statements = sqlglot.parse(sql, read="duckdb")
    except sqlglot.errors.ParseError as e:
        return ValidationResult(ok=False, error=f"SQL does not parse: {e.errors[0]['description']}")

    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        return ValidationResult(ok=False, error="Expected exactly one SQL statement")

    statement = statements[0]
    if not isinstance(statement, _READ_ONLY_ROOTS):
        return ValidationResult(
            ok=False,
            error=f"Only read-only SELECT queries are allowed, got {statement.key.upper()}",
        )

    known = {t.lower() for t in known_tables}
    cte_names = {cte.alias_or_name.lower() for cte in statement.find_all(exp.CTE)}
    for table in statement.find_all(exp.Table):
        name = table.name.lower()
        if name and name not in known and name not in cte_names:
            return ValidationResult(ok=False, error=f"Unknown table: {table.name}")

    return ValidationResult(ok=True)
