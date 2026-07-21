"""Performance budgets from the phase plans.

Marked `perf` and excluded from the default run: timings on a laptop under a
loaded CI box are noisy, and a flaky red build teaches people to ignore red
builds. Run deliberately:

    uv run pytest -m perf -q -s

Backend Phase 2, acceptance criterion 6: p95 < 150 ms for a snapshot GET of a
workspace with 50 queries and 20 charts.
"""

import statistics
import time

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

from .conftest import database_url
from .test_workspaces import auth, create_workspace, register

pytestmark = pytest.mark.perf

# The budget from the plan, and how many samples to take.
P95_BUDGET_MS = 150
SAMPLES = 60


@pytest.fixture
def client():
    """Runs against SQLite by default; point it at the real engine with

        PERF_DATABASE_URL=postgresql+asyncpg://workbench:workbench@localhost:5432/workbench

    SQLite in-memory flatters the numbers — it's the same process, no socket —
    so a passing SQLite run is necessary, not sufficient.
    """

    settings = Settings(
        anthropic_api_key="test-key",
        database_url=database_url(),
        db_auto_create=True,
        cookie_secure=False,
        jwt_secret="test-secret",
        _env_file=None,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def _big_snapshot() -> dict:
    """The shape the criterion names: 50 queries, 20 charts.

    Child ids are randomised per call: they are primary keys, global across
    workspaces, so two runs sharing them collide.
    """
    import uuid

    run = uuid.uuid4().hex[:8]
    queries = [
        {
            "id": str(uuid.uuid5(uuid.NAMESPACE_OID, f"{run}-q{i}")),
            "name": f"query {i}",
            "sql": f"SELECT * FROM orders WHERE region = 'r{i}' ORDER BY amount DESC",
            "position": i,
        }
        for i in range(50)
    ]
    charts = [
        {
            "id": str(uuid.uuid5(uuid.NAMESPACE_OID, f"{run}-c{i}")),
            "query_id": queries[i]["id"],
            "spec": {"version": 1, "type": "bar", "x": "region", "y": "amount"},
        }
        for i in range(20)
    ]
    datasets = [
        {
            "id": str(uuid.uuid5(uuid.NAMESPACE_OID, f"{run}-d{i}")),
            "name": f"dataset {i}",
            "format": "csv",
            "schema": {
                "columns": [{"name": f"c{c}", "type": "VARCHAR"} for c in range(30)]
            },
            "row_count": 100_000,
        }
        for i in range(5)
    ]
    return {
        "name": "Benchmark workspace",
        "datasets": datasets,
        "queries": queries,
        "charts": charts,
        "dashboards": [
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_OID, f"{run}-dash")),
                "name": "Overview",
                "layout": {"version": 1, "grid": [{"chart": c["id"]} for c in charts]},
            }
        ],
    }


def register_fresh(client) -> str:
    """A unique account per run.

    Unlike the SQLite suites, a Postgres perf run reuses a persistent database,
    so a fixed address collides with the previous run's signup.
    """
    import uuid

    return register(client, f"perf-{uuid.uuid4().hex}@example.com")


def _percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    index = min(int(len(ordered) * pct), len(ordered) - 1)
    return ordered[index]


def test_snapshot_get_p95_under_budget(client):
    token = register_fresh(client)
    workspace = create_workspace(client, token)
    url = f"/api/v1/workspaces/{workspace['id']}/snapshot"

    saved = client.put(url, json=_big_snapshot(), headers=auth(token))
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert len(body["queries"]) == 50
    assert len(body["charts"]) == 20

    # Warm up: first call pays for connection setup and statement compilation.
    for _ in range(5):
        client.get(url, headers=auth(token))

    timings_ms: list[float] = []
    for _ in range(SAMPLES):
        start = time.perf_counter()
        response = client.get(url, headers=auth(token))
        timings_ms.append((time.perf_counter() - start) * 1000)
        assert response.status_code == 200

    p50 = statistics.median(timings_ms)
    p95 = _percentile(timings_ms, 0.95)
    print(
        f"\nsnapshot GET (50 queries, 20 charts, 5 datasets) over {SAMPLES} samples: "
        f"p50={p50:.1f}ms p95={p95:.1f}ms max={max(timings_ms):.1f}ms"
    )
    assert p95 < P95_BUDGET_MS, f"p95 {p95:.1f}ms exceeds the {P95_BUDGET_MS}ms budget"


def test_snapshot_save_p95_under_budget(client):
    """Not in the plan, but the save path is the one users actually wait on."""
    token = register_fresh(client)
    workspace = create_workspace(client, token)
    url = f"/api/v1/workspaces/{workspace['id']}/snapshot"
    snapshot = _big_snapshot()

    for _ in range(3):
        client.put(url, json=snapshot, headers=auth(token))

    timings_ms: list[float] = []
    for _ in range(SAMPLES):
        start = time.perf_counter()
        response = client.put(url, json=snapshot, headers=auth(token))
        timings_ms.append((time.perf_counter() - start) * 1000)
        assert response.status_code == 200

    p95 = _percentile(timings_ms, 0.95)
    print(
        f"\nsnapshot PUT over {SAMPLES} samples: "
        f"p50={statistics.median(timings_ms):.1f}ms p95={p95:.1f}ms"
    )
    # A full-document upsert does far more work than a read; budget accordingly.
    assert p95 < 600, f"p95 {p95:.1f}ms is slower than expected for a snapshot save"
