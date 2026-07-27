import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

USAGE = {"input_tokens": 100, "output_tokens": 50}


def make_client(settings: Settings, model_text: str) -> TestClient:
    """App with the Anthropic call stubbed to stream `model_text`."""
    app = create_app(settings)

    async def fake_stream_model(system: str, user_message: str, user_id: str):
        app.state.ai_service.budget.check(user_id)
        for chunk in [model_text[i : i + 20] for i in range(0, len(model_text), 20)]:
            yield {"type": "delta", "text": chunk}
        app.state.ai_service.budget.record(user_id, sum(USAGE.values()))
        yield {"type": "usage", "usage": USAGE}

    app.state.ai_service._stream_model = fake_stream_model
    return TestClient(app)


def sse_events(body: str) -> list[dict]:
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


BODY = {
    "question": "total amount by region",
    "tables": [
        {
            "name": "sales",
            "columns": [
                {"name": "region", "type": "VARCHAR"},
                {"name": "amount", "type": "DOUBLE"},
            ],
        }
    ],
}


def test_healthz(settings):
    client = make_client(settings, "")
    assert client.get("/healthz").json() == {"status": "ok"}


def test_sql_endpoint_streams_and_validates(settings):
    text = "```sql\nSELECT region, SUM(amount) AS total FROM sales GROUP BY 1\n```\nSums it."
    client = make_client(settings, text)
    response = client.post("/api/v1/ai/sql", json=BODY)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = sse_events(response.text)
    types = [e["type"] for e in events]
    assert "delta" in types
    sql_event = next(e for e in events if e["type"] == "sql")
    assert "SELECT region" in sql_event["sql"]
    assert sql_event["explanation"] == "Sums it."
    assert sql_event["corrected"] is False
    assert events[-1] == {"type": "done", "usage": USAGE}


def test_sql_endpoint_surfaces_clarification(settings):
    client = make_client(settings, "CLARIFY: Which amount column do you mean?")
    events = sse_events(client.post("/api/v1/ai/sql", json=BODY).text)
    clarification = next(e for e in events if e["type"] == "clarification")
    assert clarification["question"] == "Which amount column do you mean?"
    assert not any(e["type"] == "sql" for e in events)


def test_invalid_sql_without_successful_correction_errors(settings, monkeypatch):
    client = make_client(settings, "```sql\nDROP TABLE sales\n```\nOops.")

    async def fake_correct(*args, **kwargs):
        from app.ai.parsing import parse_response

        return parse_response("```sql\nDROP TABLE sales\n```\nStill bad."), USAGE

    client.app.state.ai_service._correct = fake_correct
    events = sse_events(client.post("/api/v1/ai/sql", json=BODY).text)
    error = next(e for e in events if e["type"] == "error")
    assert error["code"] == "validation_failed"


def test_missing_api_key_returns_503(sales_table):
    settings = Settings(anthropic_api_key="", _env_file=None)
    client = make_client(settings, "")
    assert client.post("/api/v1/ai/sql", json=BODY).status_code == 503


def test_budget_exhaustion_returns_429(settings):
    client = make_client(settings, "irrelevant")
    client.app.state.ai_service.budget.record("anonymous", settings.ai_daily_token_budget)
    response = client.post("/api/v1/ai/sql", json=BODY)
    assert response.status_code == 429
    assert "budget" in response.json()["detail"].lower()


def test_explain_endpoint_streams_plaintext(settings):
    client = make_client(settings, "This query counts rows per region.")
    body = {"sql": "SELECT region, COUNT(*) FROM sales GROUP BY 1", "tables": BODY["tables"]}
    events = sse_events(client.post("/api/v1/ai/sql/explain", json=body).text)
    explanation = next(e for e in events if e["type"] == "explanation")
    assert explanation["text"] == "This query counts rows per region."


@pytest.mark.parametrize("path", ["/api/v1/ai/sql", "/api/v1/ai/sql/fix", "/api/v1/ai/sql/explain"])
def test_endpoints_reject_invalid_bodies(settings, path):
    client = make_client(settings, "")
    assert client.post(path, json={}).status_code == 422
