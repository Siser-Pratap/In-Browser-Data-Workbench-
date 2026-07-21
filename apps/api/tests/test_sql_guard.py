"""The server-side SQL boundary.

Unlike `ai/validator.py` — which filters SQL the *browser* will run — this guard
decides what executes on our hardware with our storage credentials. Every case
below is a thing an attacker would actually try.
"""

import pytest

from app.compute.sql_guard import check, inject_limit

TABLES = ["orders", "customers"]


def allowed(sql: str) -> bool:
    return check(sql, TABLES).ok


# -- what should run ----------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM orders",
        "SELECT count(*) FROM orders GROUP BY region",
        "SELECT o.id FROM orders o JOIN customers c ON o.cid = c.id",
        "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
        "SELECT * FROM (SELECT * FROM orders) t",
        "SELECT * FROM orders UNION ALL SELECT * FROM customers",
        "SELECT * FROM range(10)",
        "SELECT * FROM orders ORDER BY id LIMIT 10",
    ],
)
def test_read_only_queries_are_allowed(sql):
    assert allowed(sql), check(sql, TABLES).error


# -- statement smuggling ------------------------------------------------------


def test_multiple_statements_are_rejected():
    # The classic bypass: a checker that only inspects the first statement.
    result = check("SELECT * FROM orders; DROP TABLE orders", TABLES)
    assert not result.ok
    assert "one SQL statement" in (result.error or "")


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO orders VALUES (1)",
        "UPDATE orders SET id = 2",
        "DELETE FROM orders",
        "CREATE TABLE evil AS SELECT 1",
        "DROP TABLE orders",
        "ALTER TABLE orders ADD COLUMN x INT",
    ],
)
def test_writes_are_rejected(sql):
    assert not allowed(sql)


# -- DuckDB escape hatches ----------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "COPY orders TO '/tmp/exfil.csv'",
        "ATTACH '/etc/passwd' AS leak",
        "INSTALL httpfs",
        "LOAD httpfs",
        "PRAGMA database_list",
        "SET s3_access_key_id='stolen'",
        "CALL pragma_version()",
    ],
)
def test_duckdb_escape_hatches_are_rejected(sql):
    assert not allowed(sql)


# -- filesystem and cross-tenant reads ----------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM read_csv_auto('/etc/passwd')",
        "SELECT * FROM read_parquet('s3://another-tenant/secrets.parquet')",
        "SELECT * FROM read_json_auto('/etc/hosts')",
        "SELECT * FROM glob('/**')",
        "SELECT * FROM parquet_scan('s3://x/y')",
    ],
)
def test_file_and_network_reads_are_rejected(sql):
    """These parse as a Table with an *empty* name.

    Matching on table names alone silently lets every one of them through —
    which is exactly the bug this test exists to prevent regressing.
    """
    assert not allowed(sql)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM orders WHERE id IN (SELECT id FROM read_csv('/etc/passwd'))",
        "SELECT 1 UNION SELECT * FROM read_parquet('s3://x/y')",
        "WITH leak AS (SELECT * FROM read_csv('/etc/passwd')) SELECT * FROM leak",
        "SELECT * FROM orders UNION ALL SELECT * FROM glob('/etc/*')",
    ],
)
def test_nested_file_reads_are_rejected(sql):
    """A read-only root is not enough — the whole tree has to be checked."""
    assert not allowed(sql)


def test_unknown_tables_are_rejected():
    result = check("SELECT * FROM other_tenants_data", TABLES)
    assert not result.ok
    assert "Unknown or unavailable table" in (result.error or "")


def test_unparseable_sql_is_rejected():
    assert not allowed("SELECT FROM WHERE ((")


# -- LIMIT injection ----------------------------------------------------------


def test_limit_is_injected_when_absent():
    sql, added = inject_limit("SELECT * FROM orders", 1000)
    assert added
    # max_rows + 1, so the engine can tell "exactly full" from "truncated".
    assert sql.endswith("LIMIT 1001")


def test_a_smaller_existing_limit_is_left_alone():
    sql, added = inject_limit("SELECT * FROM orders LIMIT 5", 1000)
    assert not added
    assert "LIMIT 5" in sql


def test_a_larger_existing_limit_is_capped():
    sql, added = inject_limit("SELECT * FROM orders LIMIT 999999", 1000)
    assert added
    assert sql.endswith("LIMIT 1001")
