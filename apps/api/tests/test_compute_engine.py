"""The DuckDB compute engine, against real local files.

Datasets are bound from local paths rather than S3 — `_bind` treats a URL as an
opaque string, so the read path is identical and the tests need no MinIO.
"""

import csv
import io

import pyarrow as pa
import pytest

from app.compute.engine import (
    BoundDataset,
    ComputeError,
    EngineSettings,
    QueryTimeout,
    SQLRejected,
    run_query,
)


@pytest.fixture
def orders_csv(tmp_path):
    path = tmp_path / "orders.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "region", "amount"])
        for i in range(1000):
            writer.writerow([i, "north" if i % 2 else "south", i * 3])
    return str(path)


@pytest.fixture
def datasets(orders_csv):
    return [BoundDataset(name="orders", url=orders_csv, format="csv")]


@pytest.fixture
def settings():
    return EngineSettings(timeout_seconds=15, max_rows=100)


async def test_query_returns_arrow_the_grid_can_read(datasets, settings):
    result = await run_query(
        "SELECT region, count(*) AS c FROM orders GROUP BY region ORDER BY region",
        datasets,
        settings,
    )
    assert result.row_count == 2
    assert result.column_names == ["region", "c"]
    assert not result.truncated

    table = pa.ipc.open_stream(io.BytesIO(result.arrow_ipc)).read_all()
    assert table.num_rows == 2
    assert table.column("region").to_pylist() == ["north", "south"]


async def test_result_is_capped_and_flagged_truncated(datasets, settings):
    result = await run_query("SELECT * FROM orders", datasets, settings)
    assert result.row_count == 100
    assert result.truncated is True
    assert result.sql.endswith("LIMIT 101")


async def test_a_result_that_exactly_fills_the_cap_is_not_truncated(datasets, settings):
    result = await run_query("SELECT * FROM orders LIMIT 100", datasets, settings)
    assert result.row_count == 100
    assert result.truncated is False


async def test_rejected_sql_never_reaches_duckdb(datasets, settings):
    with pytest.raises(SQLRejected):
        await run_query("SELECT * FROM read_csv('/etc/passwd')", datasets, settings)


async def test_unknown_table_is_rejected(datasets, settings):
    with pytest.raises(SQLRejected):
        await run_query("SELECT * FROM nope", datasets, settings)


async def test_runaway_query_is_killed_at_the_timeout(datasets):
    """A cartesian join is stopped, and stopped *promptly* — the connection is
    interrupted rather than left running unobserved."""
    fast_timeout = EngineSettings(timeout_seconds=2, max_rows=100)
    with pytest.raises(QueryTimeout) as exc:
        await run_query(
            "SELECT count(*) FROM orders a, orders b, orders c, orders d",
            datasets,
            fast_timeout,
        )
    assert exc.value.code == "query_timeout"


async def test_a_bad_query_reports_cleanly(datasets, settings):
    with pytest.raises(ComputeError) as exc:
        await run_query("SELECT no_such_column FROM orders", datasets, settings)
    assert exc.value.code == "compute_failed"
    assert "no_such_column" in exc.value.message


async def test_storage_urls_are_not_leaked_in_errors(settings):
    """An engine error mentioning the object URL would hand a user our bucket
    layout; those messages are replaced wholesale."""
    missing = [BoundDataset(name="orders", url="s3://internal-bucket/secret/key.parquet",
                            format="parquet")]
    with pytest.raises(ComputeError) as exc:
        await run_query("SELECT * FROM orders", missing, settings)
    assert "s3://" not in exc.value.message
    assert "internal-bucket" not in exc.value.message


async def test_unsupported_format_is_rejected(settings):
    weird = [BoundDataset(name="orders", url="/tmp/x.xlsx", format="xlsx")]
    with pytest.raises(ComputeError):
        await run_query("SELECT * FROM orders", weird, settings)


async def test_each_query_gets_a_fresh_engine(datasets, settings):
    """No state survives between jobs — a temp view made by one query must not
    be visible to the next."""
    first = await run_query("SELECT 1 AS x", [], EngineSettings(timeout_seconds=10))
    assert first.row_count == 1
    with pytest.raises(SQLRejected):
        await run_query("SELECT * FROM orders", [], EngineSettings(timeout_seconds=10))
