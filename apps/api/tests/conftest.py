import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest

from app.ai.schemas import ColumnSchema, TableSchema
from app.core.config import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(anthropic_api_key="test-key", _env_file=None)


@pytest.fixture
def sales_profile() -> dict:
    """A TableProfile document as the frontend would send it."""
    return {
        "version": 1,
        "table": "sales",
        "row_count": 1000,
        "columns": [
            {
                "name": "region",
                "type": "VARCHAR",
                "null_pct": 0.0,
                "distinct_count": 4,
                "top_values": [
                    {"value": "EMEA", "count": 400},
                    {"value": "n/a", "count": 50},
                ],
            },
            {
                "name": "amount",
                "type": "DOUBLE",
                "null_pct": 2.5,
                "numeric": {"min": -10.0, "max": 950.0, "mean": 120.0},
            },
            {
                "name": "sold_at",
                "type": "VARCHAR",
                "null_pct": 0.0,
                "patterns": {"regex_iso_date_match_pct": 99.1},
            },
        ],
        "candidate_keys": [],
        "sample_rows_included": False,
    }


@pytest.fixture
def sales_table() -> TableSchema:
    return TableSchema(
        name="sales",
        columns=[
            ColumnSchema(name="id", type="INTEGER"),
            ColumnSchema(name="region", type="VARCHAR"),
            ColumnSchema(name="amount", type="DOUBLE"),
            ColumnSchema(name="sold_at", type="TIMESTAMP"),
        ],
        row_count=1000,
        samples={"region": ["EMEA", "APAC"]},
        column_stats={"amount": {"min": 1, "max": 950}},
    )
