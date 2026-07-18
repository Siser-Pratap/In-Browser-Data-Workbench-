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
