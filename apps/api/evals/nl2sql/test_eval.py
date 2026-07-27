"""Execution-based NL->SQL evaluation against the live model.

Run manually / nightly, never in per-PR CI:

    ANTHROPIC_API_KEY=... uv run pytest evals -m eval -v

Each case's generated SQL and expected SQL are executed against a DuckDB
database built from the dataset's setup script; a case passes when the result
sets match (as multisets, or exactly when `ordered: true`).
"""

import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import pytest

pytestmark = pytest.mark.eval

duckdb = pytest.importorskip("duckdb")
yaml = pytest.importorskip("yaml")

CASES_FILE = Path(__file__).parent / "cases.yaml"


def load_cases():
    data = yaml.safe_load(CASES_FILE.read_text())
    return [(case, data["datasets"][case["dataset"]]) for case in data["cases"]]


def rows(con, sql: str):
    return con.execute(sql).fetchall()


@pytest.fixture(scope="module")
def service():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set")
    from app.ai.service import AIService
    from app.core.config import Settings

    return AIService(Settings(_env_file=None))


def _case_id(param) -> str:
    return param["id"] if isinstance(param, dict) and "id" in param else ""


@pytest.mark.parametrize("case,dataset", load_cases(), ids=_case_id)
async def test_case(case, dataset, service):
    from app.ai.schemas import SqlGenerateRequest

    request = SqlGenerateRequest(question=case["question"], tables=dataset["tables"])

    generated_sql = None
    async for event in service.stream_sql(request, user_id="eval"):
        if event["type"] == "sql":
            generated_sql = event["sql"]
        elif event["type"] == "error":
            pytest.fail(f"model error: {event}")
        elif event["type"] == "clarification":
            pytest.fail(f"unexpected clarification: {event['question']}")
    assert generated_sql, "no SQL produced"

    con = duckdb.connect()
    con.execute(dataset["setup"])
    expected = rows(con, case["expected_sql"])
    actual = rows(con, generated_sql)

    if case.get("ordered"):
        assert actual == expected, f"\nSQL: {generated_sql}"
    else:
        assert Counter(map(tuple, actual)) == Counter(map(tuple, expected)), (
            f"\nSQL: {generated_sql}"
        )
