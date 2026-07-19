import json

from fastapi.testclient import TestClient

from app.main import create_app

USAGE = {"input_tokens": 200, "output_tokens": 120}


def make_client(settings, model_json: dict) -> TestClient:
    """App whose model call streams `model_json` as structured output."""
    app = create_app(settings)
    text = json.dumps(model_json)

    async def fake_stream_model(system, user_message, user_id, output_schema=None):
        assert output_schema is not None, "phase-2 endpoints must use structured outputs"
        app.state.ai_service.budget.check(user_id)
        yield {"type": "delta", "text": text}
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


GOOD_SUGGESTION = {
    "id": "na-placeholders",
    "severity": "warning",
    "finding": "50 of 1000 region values are the placeholder 'n/a'.",
    "proposal": "Normalize 'n/a' regions to NULL in a cleaned copy.",
    "preview_sql": "SELECT * FROM sales WHERE region = 'n/a'",
    "sql": "CREATE TABLE sales_cleaned AS "
    "SELECT * REPLACE (NULLIF(region, 'n/a') AS region) FROM sales",
    "affects_rows_estimate": 50,
}

BAD_SUGGESTION = {
    **GOOD_SUGGESTION,
    "id": "bad-mutation",
    "sql": "UPDATE sales SET region = NULL WHERE region = 'n/a'",
}

CHART = {
    "version": 1,
    "type": "bar",
    "title": "Revenue by region",
    "query": "SELECT region, SUM(amount) AS revenue FROM sales GROUP BY 1",
    "encodings": {"x": "region", "y": "revenue", "series": None},
    "options": {"x_label": None, "y_label": None, "number_format": None, "stacked": None},
}


def test_clean_returns_validated_suggestions(settings, sales_profile):
    client = make_client(settings, {"suggestions": [GOOD_SUGGESTION]})
    response = client.post("/api/v1/ai/clean", json={"profile": sales_profile})
    assert response.status_code == 200
    events = sse_events(response.text)
    payload = next(e for e in events if e["type"] == "suggestions")
    assert len(payload["suggestions"]) == 1
    assert payload["suggestions"][0]["id"] == "na-placeholders"
    assert payload["dropped"] == 0
    assert events[-1]["type"] == "done"


def test_clean_drops_invalid_suggestion_after_failed_repair(settings, sales_profile):
    client = make_client(settings, {"suggestions": [GOOD_SUGGESTION, BAD_SUGGESTION]})

    async def failing_repair(*args, **kwargs):
        return None, {"input_tokens": 0, "output_tokens": 0}

    client.app.state.ai_service._repair = failing_repair
    events = sse_events(client.post("/api/v1/ai/clean", json={"profile": sales_profile}).text)
    payload = next(e for e in events if e["type"] == "suggestions")
    assert [s["id"] for s in payload["suggestions"]] == ["na-placeholders"]
    assert payload["dropped"] == 1


def test_clean_repair_round_recovers_items(settings, sales_profile):
    client = make_client(settings, {"suggestions": [BAD_SUGGESTION]})
    fixed = {**BAD_SUGGESTION, "sql": GOOD_SUGGESTION["sql"]}

    async def repair(*args, **kwargs):
        return json.dumps({"suggestions": [fixed]}), {"input_tokens": 10, "output_tokens": 10}

    client.app.state.ai_service._repair = repair
    events = sse_events(client.post("/api/v1/ai/clean", json={"profile": sales_profile}).text)
    payload = next(e for e in events if e["type"] == "suggestions")
    assert len(payload["suggestions"]) == 1
    assert payload["dropped"] == 0
    assert events[-1]["usage"]["input_tokens"] == USAGE["input_tokens"] + 10


def test_insights_validates_verification_sql_and_chart(settings, sales_profile):
    insights = [
        {
            "headline": "EMEA drives 40% of rows",
            "detail": "400 of 1000 rows are EMEA.",
            "verification_sql": "SELECT region, COUNT(*) FROM sales GROUP BY 1",
            "confidence": "verified_by_sql",
            "chart_spec": CHART,
        },
        {
            "headline": "Bad one",
            "detail": "References a missing table.",
            "verification_sql": "SELECT * FROM missing_table",
            "confidence": "hypothesis",
            "chart_spec": None,
        },
    ]
    client = make_client(settings, {"insights": insights})

    async def failing_repair(*args, **kwargs):
        return None, {"input_tokens": 0, "output_tokens": 0}

    client.app.state.ai_service._repair = failing_repair
    events = sse_events(client.post("/api/v1/ai/insights", json={"profile": sales_profile}).text)
    payload = next(e for e in events if e["type"] == "insights")
    assert len(payload["insights"]) == 1
    assert payload["insights"][0]["headline"] == "EMEA drives 40% of rows"
    assert payload["dropped"] == 1


def test_charts_suggest_returns_specs(settings, sales_profile):
    charts = [{"rationale": "Shows regional split.", "spec": CHART}]
    client = make_client(settings, {"charts": charts})
    body = {"profile": sales_profile, "question": "which region sells most?"}
    events = sse_events(client.post("/api/v1/ai/charts/suggest", json=body).text)
    payload = next(e for e in events if e["type"] == "charts")
    assert len(payload["charts"]) == 1
    assert payload["charts"][0]["spec"]["type"] == "bar"


def test_malformed_model_output_yields_error_event(settings, sales_profile):
    client = make_client(settings, {"wrong_key": []})
    events = sse_events(client.post("/api/v1/ai/clean", json={"profile": sales_profile}).text)
    error = next(e for e in events if e["type"] == "error")
    assert error["code"] == "invalid_output"


def test_phase2_endpoints_respect_budget(settings, sales_profile):
    client = make_client(settings, {"suggestions": []})
    client.app.state.ai_service.budget.record("anonymous", settings.ai_daily_token_budget)
    for path, body in [
        ("/api/v1/ai/clean", {"profile": sales_profile}),
        ("/api/v1/ai/insights", {"profile": sales_profile}),
        ("/api/v1/ai/charts/suggest", {"profile": sales_profile}),
    ]:
        assert client.post(path, json=body).status_code == 429, path
