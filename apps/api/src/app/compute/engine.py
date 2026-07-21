"""Server-side DuckDB execution for uploaded datasets.

One ephemeral in-memory DuckDB per job — no shared state between users' queries,
so a job can't see another tenant's tables or leak a cached credential. The
connection is configured before any user SQL touches it:

- external access has to stay enabled for httpfs to read S3 at all, so the
  narrowing is done by `sql_guard` (only the dataset views we bind are nameable)
  and by locking the connection's configuration before user SQL runs. Both
  layers must fail for a query to reach the filesystem or another bucket.
- memory and thread caps keep one job from starving the box;
- the query runs under a hard timeout on a worker thread and the connection is
  interrupted (not just abandoned) when it expires.

Results come back as Arrow IPC — the same bytes the browser grid already
consumes, so there's no second rendering path for server results.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from . import sql_guard

logger = logging.getLogger("app.compute")

# How long to wait for an interrupted query's thread to unwind before giving up
# on it. DuckDB stops promptly; this is only so the exception gets collected.
_INTERRUPT_GRACE_SECONDS = 5


class ComputeError(Exception):
    """A user-visible failure: bad SQL, timeout, or too much data."""

    code = "compute_failed"

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code


class QueryTimeout(ComputeError):
    code = "query_timeout"


class SQLRejected(ComputeError):
    code = "sql_rejected"


@dataclass
class BoundDataset:
    """A dataset made available to a query, by name, from object storage."""

    name: str
    url: str  # s3://bucket/key
    format: str  # parquet | csv | json


@dataclass
class ComputeResult:
    arrow_ipc: bytes
    row_count: int
    column_names: list[str] = field(default_factory=list)
    truncated: bool = False
    sql: str = ""


@dataclass
class EngineSettings:
    memory_limit: str = "2GB"
    threads: int = 2
    timeout_seconds: int = 60
    max_rows: int = 1_000_000
    # S3 credentials for httpfs; the worker holds these, the user never sees them.
    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_use_ssl: bool = True


def _configure(conn: Any, settings: EngineSettings) -> None:
    conn.execute(f"SET memory_limit='{settings.memory_limit}'")
    conn.execute(f"SET threads={settings.threads}")
    conn.execute("SET enable_progress_bar=false")
    # Extensions are fetched and signed-checked by DuckDB; never widen this.
    conn.execute("SET allow_unsigned_extensions=false")

    if settings.s3_access_key:
        conn.execute("INSTALL httpfs")
        conn.execute("LOAD httpfs")
        conn.execute(f"SET s3_region='{settings.s3_region}'")
        conn.execute(f"SET s3_access_key_id='{settings.s3_access_key}'")
        conn.execute(f"SET s3_secret_access_key='{settings.s3_secret_key}'")
        conn.execute(f"SET s3_use_ssl={'true' if settings.s3_use_ssl else 'false'}")
        if settings.s3_endpoint:
            # MinIO and other S3-compatibles need path-style addressing.
            conn.execute(f"SET s3_endpoint='{settings.s3_endpoint}'")
            conn.execute("SET s3_url_style='path'")


_READERS = {
    "parquet": "read_parquet",
    "csv": "read_csv_auto",
    "tsv": "read_csv_auto",
    "json": "read_json_auto",
}


def _bind(conn: Any, datasets: list[BoundDataset]) -> None:
    """Expose each dataset as a view, so user SQL only ever names identifiers.

    The storage URL is interpolated here — in the one place the user's SQL can't
    reach — and never appears in the statement the guard checked.
    """
    for dataset in datasets:
        reader = _READERS.get(dataset.format.lower())
        if reader is None:
            raise ComputeError(f"Cannot query {dataset.format} files on the server")
        if "'" in dataset.url or "'" in dataset.name:
            raise ComputeError("Invalid dataset reference")
        conn.execute(f'CREATE VIEW "{dataset.name}" AS SELECT * FROM {reader}(\'{dataset.url}\')')


def _to_ipc(table: Any) -> bytes:
    import io

    import pyarrow as pa

    sink = io.BytesIO()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue()


def _clean_duckdb_error(exc: Exception) -> str:
    """Surface the engine's message without leaking storage URLs or keys."""
    message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
    for marker in ("s3://", "http://", "https://"):
        if marker in message:
            return "Query failed while reading the dataset"
    return message[:500]


async def run_query(
    sql: str,
    datasets: list[BoundDataset],
    settings: EngineSettings,
) -> ComputeResult:
    """Validate, then execute under a hard timeout.

    DuckDB is synchronous, so the query runs on a worker thread; on timeout the
    connection is interrupted so the thread actually stops rather than running
    on unobserved.
    """
    guard = sql_guard.check(sql, [d.name for d in datasets])
    if not guard.ok:
        raise SQLRejected(guard.error or "SQL rejected")

    loop = asyncio.get_running_loop()
    holder: dict[str, Any] = {}

    def _work() -> ComputeResult:
        import duckdb

        conn = duckdb.connect(":memory:")
        holder["conn"] = conn
        try:
            _configure(conn, settings)
            _bind(conn, datasets)
            # Freeze the connection before user SQL runs: even if a statement
            # slipped past the guard, it can no longer re-point S3 credentials
            # or widen file access.
            conn.execute("SET lock_configuration=true")

            capped_sql, was_capped = sql_guard.inject_limit(sql, settings.max_rows)
            result_set = conn.execute(capped_sql)
            fetch = getattr(result_set, "to_arrow_table", None) or result_set.fetch_arrow_table
            table = fetch()
            truncated = was_capped and table.num_rows > settings.max_rows
            if truncated:
                table = table.slice(0, settings.max_rows)
            return ComputeResult(
                arrow_ipc=_to_ipc(table),
                row_count=table.num_rows,
                column_names=list(table.column_names),
                truncated=truncated,
                sql=capped_sql,
            )
        except Exception as exc:
            if type(exc).__name__ in ("InterruptException", "InterruptedException"):
                raise QueryTimeout(
                    f"Query exceeded the {settings.timeout_seconds}s limit"
                ) from exc
            raise ComputeError(_clean_duckdb_error(exc)) from exc
        finally:
            conn.close()

    # A dedicated executor per query rather than the loop's default one: DuckDB
    # holds native state, and the default executor's lifetime is tied to the
    # event loop's. A loop shutting down under an in-flight query takes the
    # process with it. One thread per query is free next to the query itself.
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="duckdb")
    task = loop.run_in_executor(executor, _work)
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=settings.timeout_seconds)
    except TimeoutError as exc:
        conn = holder.get("conn")
        if conn is not None:
            # Stops the running query; the executor thread then unwinds.
            conn.interrupt()
        # Collect the thread's own QueryTimeout rather than leaving it on an
        # abandoned future, which asyncio reports as "never retrieved".
        with contextlib.suppress(Exception):
            await asyncio.wait_for(task, timeout=_INTERRUPT_GRACE_SECONDS)
        raise QueryTimeout(f"Query exceeded the {settings.timeout_seconds}s limit") from exc
    finally:
        # Don't block on a thread still unwinding an interrupted query.
        executor.shutdown(wait=False)
