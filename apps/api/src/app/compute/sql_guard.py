"""Statement classification for **server-side** query execution.

This is not the same job as `ai/validator.py`. That module filters generated SQL
that the browser will run on the user's own machine, so a miss costs quality.
Here the SQL runs on our hardware against other tenants' storage credentials, so
a miss is a breach. The rules are correspondingly paranoid:

- exactly one statement, and it must be a read-only SELECT-family root;
- no DuckDB escape hatches — `ATTACH`, `COPY ... TO`, `INSTALL`/`LOAD`,
  `PRAGMA`/`SET`, `EXPORT`, `CALL`;
- no filesystem or network reachable from a table function: every source must
  be one of the dataset names we bound into the session, so `read_csv('/etc/…')`,
  `read_parquet('s3://someone-elses-bucket/…')` and `url` reads all fail.

Defense in depth: `engine.py` additionally runs DuckDB with `enable_external_access`
off except for the specific S3 prefixes it binds, so a parser bypass still hits a
closed door.
"""

from __future__ import annotations

from dataclasses import dataclass

import sqlglot
from sqlglot import exp

_READ_ONLY_ROOTS = (exp.Select, exp.Union, exp.Intersect, exp.Except)

# Table functions that reach outside the bound datasets. Anything not in the
# allowlist below is rejected by name, so this list is belt-and-braces for
# clearer error messages on the obvious attempts.
_FILE_FUNCTIONS = {
    "read_csv",
    "read_csv_auto",
    "read_parquet",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_text",
    "read_blob",
    "parquet_scan",
    "csv_scan",
    "glob",
    "sniff_csv",
    "delta_scan",
    "iceberg_scan",
}

# Set-returning functions that are pure computation and safe to allow.
_SAFE_TABLE_FUNCTIONS = {"range", "generate_series", "unnest"}


@dataclass
class GuardResult:
    ok: bool
    error: str | None = None


def check(sql: str, allowed_tables: list[str]) -> GuardResult:
    """Classify one statement for server-side execution.

    `allowed_tables` are the dataset names bound into the session as views.
    """
    try:
        statements = sqlglot.parse(sql, read="duckdb")
    except sqlglot.errors.ParseError as e:
        detail = e.errors[0]["description"] if e.errors else str(e)
        return GuardResult(False, f"SQL does not parse: {detail}")

    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        # Multi-statement is how you smuggle a second, unchecked command past a
        # check that only looks at the first one.
        return GuardResult(False, "Expected exactly one SQL statement")

    statement = statements[0]
    if not isinstance(statement, _READ_ONLY_ROOTS):
        return GuardResult(
            False, f"Only read-only SELECT queries can run on the server, got {_kind(statement)}"
        )

    # A SELECT root can still hide a write in a subquery or a CTE body.
    for node in statement.walk():
        if _is_write(node):
            return GuardResult(False, f"Statement contains a non-read operation: {_kind(node)}")

    allowed = {t.lower() for t in allowed_tables}
    cte_names = {cte.alias_or_name.lower() for cte in statement.find_all(exp.CTE)}

    # Allowlist, not blocklist. Every FROM source must be a plain identifier we
    # bound into the session. A table function (`read_csv(...)`, `read_parquet(
    # 's3://...')`, `glob(...)`) parses as a Table whose `this` is *not* an
    # Identifier — matching on name alone would skip it, since its `.name` is "".
    for table in statement.find_all(exp.Table):
        source = table.this

        if isinstance(source, exp.Identifier):
            name = table.name.lower()
            if name in cte_names or name in allowed:
                continue
            return GuardResult(False, f"Unknown or unavailable table: {table.name}")

        func = _function_name(source)
        if func in _SAFE_TABLE_FUNCTIONS:
            continue
        if func in _FILE_FUNCTIONS:
            return GuardResult(
                False,
                f"{func}() cannot be used on the server; query the dataset by name instead",
            )
        return GuardResult(
            False,
            f"Only bound datasets can be queried on the server, got {func or 'an expression'}",
        )

    return GuardResult(True)


def _function_name(node: exp.Expression | None) -> str:
    """The callable name behind a table source, lowercased.

    sqlglot gives some table functions dedicated node classes (`ReadCSV`,
    `ReadParquet`, `GenerateSeries`) and leaves the rest as `Anonymous`.
    """
    if node is None:
        return ""
    if isinstance(node, exp.Anonymous) and isinstance(node.this, str):
        return node.this.lower()
    return _CLASS_TO_FUNCTION.get(type(node).__name__, type(node).__name__.lower())


# Dedicated sqlglot node classes -> the DuckDB function they represent.
_CLASS_TO_FUNCTION = {
    "ReadCSV": "read_csv",
    "ReadParquet": "read_parquet",
    "GenerateSeries": "generate_series",
    "Explode": "unnest",
    "Unnest": "unnest",
}


_WRITE_NODE_NAMES = (
    "Insert",
    "Update",
    "Delete",
    "Create",
    "Drop",
    "Alter",
    "Copy",
    "Command",  # ATTACH / INSTALL / LOAD / PRAGMA / EXPORT / CALL land here
    "Set",
    "Use",
    "Merge",
    "Grant",
    "Attach",
    "Detach",
    "Pragma",
    "Transaction",
    "Commit",
    "Rollback",
)
# Resolved by name: sqlglot adds and renames node classes between versions, and
# a missing attribute here must not silently drop a rule.
_WRITE_NODES = tuple(
    node for node in (getattr(exp, name, None) for name in _WRITE_NODE_NAMES) if node is not None
)


def _is_write(node: exp.Expression) -> bool:
    return isinstance(node, _WRITE_NODES)


def _kind(node: exp.Expression) -> str:
    # `exp.Command` carries the raw keyword (ATTACH, PRAGMA, ...) in `this`.
    if isinstance(node, exp.Command) and isinstance(node.this, str):
        return node.this.upper()
    return node.key.upper()


def inject_limit(sql: str, max_rows: int) -> tuple[str, bool]:
    """Cap the result size in the query itself.

    Returns `(sql, limit_was_added)`. A query that already asks for fewer rows is
    left alone; anything else gets `LIMIT max_rows + 1` so the engine can tell
    "exactly full" from "truncated".
    """
    try:
        statement = sqlglot.parse_one(sql, read="duckdb")
    except sqlglot.errors.ParseError:
        return sql, False

    existing = statement.args.get("limit")
    if existing is not None:
        try:
            if int(existing.expression.this) <= max_rows:
                return statement.sql(dialect="duckdb"), False
        except (AttributeError, TypeError, ValueError):
            pass  # Non-literal LIMIT (expression, parameter): impose our own.

    capped = statement.limit(max_rows + 1)
    return capped.sql(dialect="duckdb"), True
