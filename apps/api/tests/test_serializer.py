from app.ai.schemas import ColumnSchema, TableSchema
from app.ai.serializer import serialize_tables


def test_full_rendering_includes_stats_samples_and_rowcount(sales_table):
    rendered = serialize_tables([sales_table], max_chars=10_000)
    assert "CREATE TABLE sales" in rendered
    assert "region VARCHAR" in rendered
    assert "'EMEA'" in rendered  # sample values
    assert "min=1" in rendered  # column stats
    assert "1000 rows" in rendered


def test_truncation_drops_stats_before_samples():
    table = TableSchema(
        name="t",
        columns=[ColumnSchema(name="c", type="VARCHAR")],
        samples={"c": ["short"]},
        column_stats={"c": {"padding": "x" * 500}},
    )
    full = serialize_tables([table], max_chars=10_000)
    assert "padding" in full and "'short'" in full

    reduced = serialize_tables([table], max_chars=200)
    assert "padding" not in reduced
    assert "'short'" in reduced


def test_minimal_rendering_truncates_wide_tables():
    table = TableSchema(
        name="wide",
        columns=[ColumnSchema(name=f"col_{i}", type="VARCHAR") for i in range(200)],
    )
    rendered = serialize_tables([table], max_chars=2500)
    assert "more columns omitted" in rendered
    assert len(rendered) <= 2500


def test_non_identifier_names_are_quoted():
    table = TableSchema(
        name="my table",
        columns=[ColumnSchema(name="weird col", type="VARCHAR")],
    )
    rendered = serialize_tables([table], max_chars=10_000)
    assert '"my table"' in rendered
    assert '"weird col"' in rendered
