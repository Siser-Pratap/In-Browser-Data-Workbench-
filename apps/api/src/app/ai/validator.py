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


def validate_sql(
    sql: str, known_tables: list[str], allow_ctas: bool = False
) -> ValidationResult:
    """Validate one statement.

    With `allow_ctas=True` (cleaning proposals), `CREATE TABLE new AS SELECT ...`
    is additionally accepted — materialize a new table, never mutate in place, so
    the created table must not shadow an existing one.
    """
    try:
        statements = sqlglot.parse(sql, read="duckdb")
    except sqlglot.errors.ParseError as e:
        return ValidationResult(ok=False, error=f"SQL does not parse: {e.errors[0]['description']}")

    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        return ValidationResult(ok=False, error="Expected exactly one SQL statement")

    statement = statements[0]
    known = {t.lower() for t in known_tables}

    if allow_ctas and isinstance(statement, exp.Create):
        if (statement.kind or "").upper() != "TABLE":
            return ValidationResult(ok=False, error="Only CREATE TABLE ... AS SELECT is allowed")
        scan_root = statement.expression
        if not isinstance(scan_root, _READ_ONLY_ROOTS):
            return ValidationResult(
                ok=False, error="CREATE TABLE is only allowed as CREATE TABLE ... AS SELECT"
            )
        target = statement.this
        target_table = target if isinstance(target, exp.Table) else target.find(exp.Table)
        target_name = target_table.name.lower() if target_table is not None else ""
        if target_name in known:
            return ValidationResult(
                ok=False,
                error=f"Would overwrite existing table {target_name}; create a new table instead",
            )
    elif isinstance(statement, _READ_ONLY_ROOTS):
        scan_root = statement
    else:
        return ValidationResult(
            ok=False,
            error=f"Only read-only SELECT queries are allowed, got {statement.key.upper()}",
        )

    cte_names = {cte.alias_or_name.lower() for cte in scan_root.find_all(exp.CTE)}
    for table in scan_root.find_all(exp.Table):
        name = table.name.lower()
        if name and name not in known and name not in cte_names:
            return ValidationResult(ok=False, error=f"Unknown table: {table.name}")

    return ValidationResult(ok=True)
