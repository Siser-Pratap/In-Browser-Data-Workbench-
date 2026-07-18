from app.ai.parsing import parse_response


def test_parses_sql_block_and_explanation():
    text = "```sql\nSELECT 1\n```\nCounts to one."
    parsed = parse_response(text)
    assert parsed.sql == "SELECT 1"
    assert parsed.explanation == "Counts to one."
    assert parsed.clarification is None


def test_parses_bare_fence_without_language_tag():
    parsed = parse_response("```\nSELECT 2\n```\nTwo.")
    assert parsed.sql == "SELECT 2"


def test_parses_clarification():
    parsed = parse_response("CLARIFY: Do you mean revenue before or after refunds?")
    assert parsed.sql is None
    assert parsed.clarification == "Do you mean revenue before or after refunds?"


def test_no_sql_block_returns_empty():
    parsed = parse_response("I cannot answer that.")
    assert parsed.sql is None
    assert parsed.clarification is None
