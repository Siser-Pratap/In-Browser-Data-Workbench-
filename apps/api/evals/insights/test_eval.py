"""Execution-based evals for the Phase 2 cleaning + insights endpoints.

Run manually / nightly:

    ANTHROPIC_API_KEY=... uv run pytest evals/insights -m eval -v

Cleaning cases measure planted-defect recall and require every returned `sql`
to validate as CTAS and execute. Insight cases require every displayed
insight's `verification_sql` to execute and the planted signal to appear.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import pytest

pytestmark = pytest.mark.eval

duckdb = pytest.importorskip("duckdb")
yaml = pytest.importorskip("yaml")

CASES_FILE = Path(__file__).parent / "cases.yaml"


def _load():
    data = yaml.safe_load(CASES_FILE.read_text())
    return data


def _cleaning_cases():
    data = _load()
    return [(c, data["datasets"][c["dataset"]]) for c in data.get("cleaning_cases", [])]


def _insight_cases():
    data = _load()
    return [(c, data["datasets"][c["dataset"]]) for c in data.get("insight_cases", [])]


def _case_id(param):
    return param["id"] if isinstance(param, dict) and "id" in param else ""


@pytest.fixture(scope="module")
def service():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set")
    from app.ai.service import AIService
    from app.core.config import Settings

    return AIService(Settings(_env_file=None))


async def _collect(stream, key):
    payload = None
    async for event in stream:
        if event["type"] == key:
            payload = event
        elif event["type"] == "error":
            pytest.fail(f"model error: {event}")
    assert payload is not None, f"no '{key}' event produced"
    return payload


@pytest.mark.parametrize("case,dataset", _cleaning_cases(), ids=_case_id)
async def test_cleaning(case, dataset, service):
    from app.ai.profile import TableProfile
    from app.ai.schemas import CleanRequest

    request = CleanRequest(profile=TableProfile.model_validate(dataset["profile"]))
    payload = await _collect(service.stream_clean(request, "eval"), "suggestions")
    suggestions = payload["suggestions"]

    # Every proposed cleaning SQL must actually run against the seeded table.
    con = duckdb.connect()
    con.execute(dataset["setup"])
    for s in suggestions:
        con.execute(s["sql"])  # raises if the CTAS is not executable

    haystack = " ".join(
        f"{s['id']} {s['finding']} {s['proposal']}".lower() for s in suggestions
    )
    missed = [d for d in case["expected_defects"] if d.lower() not in haystack]
    recall = 1 - len(missed) / len(case["expected_defects"])
    assert recall >= 0.66, f"recall {recall:.2f}, missed {missed}"


@pytest.mark.parametrize("case,dataset", _insight_cases(), ids=_case_id)
async def test_insights(case, dataset, service):
    from app.ai.profile import TableProfile
    from app.ai.schemas import InsightsRequest

    request = InsightsRequest(profile=TableProfile.model_validate(dataset["profile"]))
    payload = await _collect(service.stream_insights(request, "eval"), "insights")
    insights = payload["insights"]
    assert insights, "no insights produced"

    con = duckdb.connect()
    con.execute(dataset["setup"])
    for i in insights:
        con.execute(i["verification_sql"])  # every displayed insight must be checkable

    headlines = " ".join(i["headline"].lower() for i in insights)
    assert case["expected_signal"].lower() in headlines
