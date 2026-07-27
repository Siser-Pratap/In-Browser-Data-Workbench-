import pytest
from pydantic import ValidationError

from app.ai.chartspec import ChartEncodings, ChartSpec, validate_chart_spec


def make_spec(**overrides) -> ChartSpec:
    base = dict(
        type="bar",
        title="Revenue by region",
        query="SELECT region, SUM(amount) AS revenue FROM sales GROUP BY 1",
        encodings=ChartEncodings(x="region", y="revenue"),
    )
    base.update(overrides)
    return ChartSpec(**base)


def test_valid_spec_passes():
    assert validate_chart_spec(make_spec(), ["sales"]).ok


def test_unknown_table_in_query_fails():
    result = validate_chart_spec(make_spec(), ["orders"])
    assert not result.ok
    assert "sales" in result.error


def test_mutating_query_fails():
    spec = make_spec(query="DELETE FROM sales")
    assert not validate_chart_spec(spec, ["sales"]).ok


def test_unknown_chart_type_rejected():
    with pytest.raises(ValidationError):
        make_spec(type="treemap")


def test_extra_fields_rejected():
    with pytest.raises(ValidationError):
        ChartSpec(
            type="bar",
            title="t",
            query="SELECT 1",
            encodings=ChartEncodings(),
            surprise="field",
        )
