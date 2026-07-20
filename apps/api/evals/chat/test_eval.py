"""Live scenario + injection evals for the conversational analyst.

    ANTHROPIC_API_KEY=... uv run pytest evals/chat -m eval -v

The harness plays the browser: it executes each tool call the agent makes
against a DuckDB database, feeds results back, and loops until the turn
completes — exercising the same server-side loop the real frontend drives.
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
    return yaml.safe_load(CASES_FILE.read_text())


def _scenario_cases():
    data = _load()
    return [(c, data["datasets"][c["dataset"]]) for c in data.get("scenario_cases", [])]


def _injection_cases():
    data = _load()
    return [(c, data["datasets"][c["dataset"]]) for c in data.get("injection_cases", [])]


def _case_id(param):
    return param["id"] if isinstance(param, dict) and "id" in param else ""


@pytest.fixture(scope="module")
def service():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set")
    from app.ai.budget import TokenBudget
    from app.ai.chat_service import ChatService
    from app.core.config import Settings

    settings = Settings(_env_file=None)
    return ChatService(settings, TokenBudget(daily_limit=settings.ai_daily_token_budget))


def _execute_tool(name: str, tool_input: dict, con) -> object:
    """The 'browser': run a tool call against the seeded DuckDB."""
    if name == "list_tables":
        return [r[0] for r in con.execute("SHOW TABLES").fetchall()]
    if name == "get_schema":
        rows = con.execute(f"DESCRIBE {tool_input['table']}").fetchall()
        return [{"name": r[0], "type": r[1]} for r in rows]
    if name == "get_profile":
        table = tool_input["table"]
        n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        cols = con.execute(f"DESCRIBE {table}").fetchall()
        return {"row_count": n, "columns": [{"name": c[0], "type": c[1]} for c in cols]}
    if name in ("run_sql", "create_chart"):
        sql = tool_input["sql"] if name == "run_sql" else tool_input["query"]
        cur = con.execute(sql)
        columns = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchall()
        return {"columns": columns, "rows": [list(r) for r in rows[:200]], "row_count": len(rows)}
    if name == "save_query":
        return {"ok": True}
    return {"error": f"unknown tool {name}"}


async def _run_turn(service, session_id, stream, con) -> str:
    """Drain a turn, executing tool calls and resuming, until `done`."""
    from app.ai.schemas import ClientToolResult

    while True:
        tool_calls, awaiting, last_message = [], False, ""
        async for event in stream:
            if event["type"] == "message":
                last_message = event["text"]
            elif event["type"] == "tool_call":
                tool_calls.append(event)
            elif event["type"] == "awaiting_tools":
                awaiting = True
            elif event["type"] == "error":
                pytest.fail(f"agent error: {event}")
            elif event["type"] == "done":
                return last_message
        if not awaiting:
            return last_message

        results = [
            ClientToolResult(
                tool_use_id=tc["tool_use_id"],
                content=_execute_tool(tc["name"], tc["input"], con),
            )
            for tc in tool_calls
        ]
        stream = service.submit_tool_results(session_id, results, "eval")


@pytest.mark.parametrize("case,dataset", _scenario_cases(), ids=_case_id)
async def test_scenario(case, dataset, service):
    from app.ai.schemas import ChatCreateRequest, TableSchema

    con = duckdb.connect()
    con.execute(dataset["setup"])
    tables = [TableSchema.model_validate(t) for t in dataset["tables"]]
    session_id, _ = service.create_session(ChatCreateRequest(tables=tables), "eval")

    final = ""
    for message in case["messages"]:
        final = await _run_turn(
            service, session_id, service.send_message(session_id, message, "eval"), con
        )

    for needle in case["expect_contains"]:
        assert needle in final, f"expected {needle!r} in answer:\n{final}"


@pytest.mark.parametrize("case,dataset", _injection_cases(), ids=_case_id)
async def test_injection(case, dataset, service):
    from app.ai.schemas import ChatCreateRequest, TableSchema

    con = duckdb.connect()
    con.execute(dataset["setup"])
    tables = [TableSchema.model_validate(t) for t in dataset["tables"]]
    session_id, _ = service.create_session(ChatCreateRequest(tables=tables), "eval")

    final = await _run_turn(
        service, session_id, service.send_message(session_id, case["message"], "eval"), con
    )
    for forbidden in case["must_not_contain"]:
        assert forbidden not in final, f"agent obeyed a planted instruction:\n{final}"
