"""Tests for the conversational analyst.

The model seam (`ChatService._call_model`) is replaced with a scripted fake that
yields pre-baked assistant turns, so the full loop — streaming, tool triage,
server-side SQL validation, pause/resume, and the caps — is exercised
deterministically without the network.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

USAGE = {"input_tokens": 100, "output_tokens": 40}

TABLES = [
    {
        "name": "sales",
        "columns": [
            {"name": "region", "type": "VARCHAR"},
            {"name": "amount", "type": "DOUBLE"},
            {"name": "sold_at", "type": "TIMESTAMP"},
        ],
    }
]


def text_block(text: str) -> dict:
    return {"type": "text", "text": text}


def tool_block(tool_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}


class ScriptedModel:
    """Returns the next scripted turn each time the loop calls the model.

    A turn is a list of content blocks. `force_wrap=True` calls (tool_choice
    none) consume the `wrap` turn instead of the script, so the caps terminate.
    """

    def __init__(self, turns: list[list[dict]], wrap: list[dict] | None = None) -> None:
        self.turns = list(turns)
        self.wrap = wrap or [text_block("Wrapping up.")]
        self.calls: list[bool] = []

    async def __call__(self, session, force_wrap):
        self.calls.append(force_wrap)
        content = self.wrap if force_wrap else self.turns.pop(0)
        for block in content:
            if block["type"] == "text":
                yield {"type": "delta", "text": block["text"]}
        yield {"type": "final", "content": content, "usage": USAGE}


def make_client(settings, model: ScriptedModel) -> TestClient:
    app = create_app(settings)
    app.state.chat_service._call_model = model
    return TestClient(app)


def sse_events(body: str) -> list[dict]:
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


def create_session(client: TestClient) -> str:
    resp = client.post("/api/v1/ai/chat", json={"tables": TABLES})
    assert resp.status_code == 200
    return resp.json()["session_id"]


# -- session creation ---------------------------------------------------------


def test_create_session_returns_starter_prompts(settings):
    client = make_client(settings, ScriptedModel([]))
    body = client.post("/api/v1/ai/chat", json={"tables": TABLES}).json()
    assert body["session_id"].startswith("chat_")
    assert any("sales" in p for p in body["starter_prompts"])


# -- plain turn (no tools) ----------------------------------------------------


def test_text_only_turn_completes(settings):
    model = ScriptedModel([[text_block("Hello, I can help analyze your data.")]])
    client = make_client(settings, model)
    session_id = create_session(client)
    events = sse_events(
        client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "hi"}).text
    )
    types = [e["type"] for e in events]
    assert "delta" in types
    message = next(e for e in events if e["type"] == "message")
    assert message["text"] == "Hello, I can help analyze your data."
    assert events[-1] == {"type": "done", "usage": USAGE}


# -- tool round-trip ----------------------------------------------------------


def test_valid_run_sql_pauses_for_client_then_resumes(settings):
    model = ScriptedModel(
        [
            [
                text_block("Let me total sales by region."),
                tool_block(
                    "t1",
                    "run_sql",
                    {"sql": "SELECT region, SUM(amount) FROM sales GROUP BY 1"},
                ),
            ],
            [text_block("EMEA leads with the highest total.")],
        ]
    )
    client = make_client(settings, model)
    session_id = create_session(client)

    events = sse_events(
        client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "top region?"}).text
    )
    tool_call = next(e for e in events if e["type"] == "tool_call")
    assert tool_call["name"] == "run_sql"
    assert tool_call["tool_use_id"] == "t1"
    assert events[-1] == {"type": "awaiting_tools"}
    assert not any(e["type"] == "done" for e in events)

    # Browser executes and returns results.
    resume = client.post(
        f"/api/v1/ai/chat/{session_id}/tool-result",
        json={"results": [{"tool_use_id": "t1", "content": [{"region": "EMEA", "sum": 5000}]}]},
    )
    resume_events = sse_events(resume.text)
    message = next(e for e in resume_events if e["type"] == "message")
    assert "EMEA" in message["text"]
    assert resume_events[-1]["type"] == "done"


def test_invalid_sql_is_resolved_server_side_without_client(settings):
    # First turn: a mutating query (rejected server-side) -> model self-corrects
    # in the second turn without any client round-trip.
    model = ScriptedModel(
        [
            [tool_block("bad", "run_sql", {"sql": "DROP TABLE sales"})],
            [
                tool_block(
                    "good", "run_sql", {"sql": "SELECT COUNT(*) FROM sales"}
                )
            ],
            [text_block("There are 1000 rows.")],
        ]
    )
    client = make_client(settings, model)
    session_id = create_session(client)

    events = sse_events(
        client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "count"}).text
    )
    # The invalid DROP never reaches the client; only the corrected SELECT does.
    tool_calls = [e for e in events if e["type"] == "tool_call"]
    assert len(tool_calls) == 1
    assert tool_calls[0]["tool_use_id"] == "good"
    assert events[-1] == {"type": "awaiting_tools"}


def test_ctas_registers_new_table_for_later_queries(settings):
    ctas = "CREATE TABLE big AS SELECT * FROM sales WHERE amount > 100"
    model = ScriptedModel([[tool_block("t1", "run_sql", {"sql": ctas})]])
    client = make_client(settings, model)
    session_id = create_session(client)
    events = sse_events(
        client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "materialize"}).text
    )
    assert next(e for e in events if e["type"] == "tool_call")["name"] == "run_sql"
    session = client.app.state.chat_service.sessions._sessions[session_id]
    assert "big" in session.known_tables


def test_invalid_chart_spec_resolved_server_side(settings):
    bad_chart = {"type": "bar", "title": "x", "query": "DELETE FROM sales", "encodings": {}}
    model = ScriptedModel(
        [
            [tool_block("c1", "create_chart", bad_chart)],
            [text_block("Let me reconsider.")],
        ]
    )
    client = make_client(settings, model)
    session_id = create_session(client)
    events = sse_events(
        client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "chart it"}).text
    )
    # Bad chart query never reaches the client; the turn completes after correction.
    assert not any(e["type"] == "tool_call" for e in events)
    assert events[-1]["type"] == "done"


# -- caps & guards ------------------------------------------------------------


def test_tool_call_cap_forces_wrap_up(settings):
    settings.ai_chat_max_tool_calls_per_turn = 2
    # Two client tool round-trips, then the cap forces a tools-off wrap.
    turns = [
        [tool_block("a", "get_profile", {"table": "sales"})],
        [tool_block("b", "get_profile", {"table": "sales"})],
    ]
    model = ScriptedModel(turns, wrap=[text_block("Reached the tool limit; here's what I found.")])
    client = make_client(settings, model)
    session_id = create_session(client)

    # message -> tool a
    client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "go"})
    # result a -> tool b
    client.post(
        f"/api/v1/ai/chat/{session_id}/tool-result",
        json={"results": [{"tool_use_id": "a", "content": {}}]},
    )
    # result b -> cap hit -> forced wrap (tools off) -> done
    final = sse_events(
        client.post(
            f"/api/v1/ai/chat/{session_id}/tool-result",
            json={"results": [{"tool_use_id": "b", "content": {}}]},
        ).text
    )
    assert final[-1]["type"] == "done"
    assert model.calls[-1] is True  # last model call forced tools off


def test_turn_limit_rejects_new_messages(settings):
    settings.ai_chat_max_turns = 1
    model = ScriptedModel([[text_block("First answer.")], [text_block("unused")]])
    client = make_client(settings, model)
    session_id = create_session(client)
    client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "one"})
    events = sse_events(
        client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "two"}).text
    )
    error = next(e for e in events if e["type"] == "error")
    assert error["code"] == "turn_limit"


def test_tool_result_mismatch_returns_error_event(settings):
    model = ScriptedModel(
        [[tool_block("t1", "get_profile", {"table": "sales"})]]
    )
    client = make_client(settings, model)
    session_id = create_session(client)
    client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "go"})
    events = sse_events(
        client.post(
            f"/api/v1/ai/chat/{session_id}/tool-result",
            json={"results": [{"tool_use_id": "WRONG", "content": {}}]},
        ).text
    )
    assert next(e for e in events if e["type"] == "error")["code"] == "not_awaiting_tools"


def test_unknown_session_is_404(settings):
    client = make_client(settings, ScriptedModel([]))
    assert (
        client.post("/api/v1/ai/chat/chat_missing/message", json={"content": "hi"}).status_code
        == 404
    )


def test_sessions_are_scoped_to_user(settings):
    client = make_client(settings, ScriptedModel([[text_block("hi")]]))
    session_id = client.post(
        "/api/v1/ai/chat", json={"tables": TABLES}, headers={"X-User-Id": "alice"}
    ).json()["session_id"]
    # Bob cannot reach Alice's session.
    resp = client.post(
        f"/api/v1/ai/chat/{session_id}/message",
        json={"content": "hi"},
        headers={"X-User-Id": "bob"},
    )
    assert resp.status_code == 404


def test_chat_missing_api_key_returns_503():
    from app.core.config import Settings

    settings = Settings(anthropic_api_key="", _env_file=None)
    client = make_client(settings, ScriptedModel([]))
    assert client.post("/api/v1/ai/chat", json={"tables": TABLES}).status_code == 503


def test_chat_respects_daily_budget(settings):
    model = ScriptedModel([[text_block("hi")]])
    client = make_client(settings, model)
    session_id = create_session(client)
    client.app.state.chat_service.budget.record("anonymous", settings.ai_daily_token_budget)
    resp = client.post(f"/api/v1/ai/chat/{session_id}/message", json={"content": "hi"})
    assert resp.status_code == 429


@pytest.mark.parametrize(
    "payload",
    [{"tables": []}, {}],
)
def test_create_chat_rejects_invalid_body(settings, payload):
    client = make_client(settings, ScriptedModel([]))
    assert client.post("/api/v1/ai/chat", json=payload).status_code == 422
