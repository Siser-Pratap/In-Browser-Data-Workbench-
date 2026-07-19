from app.ai.validator import validate_sql

TABLES = ["sales", "products"]


def test_accepts_simple_select():
    assert validate_sql("SELECT region, SUM(amount) FROM sales GROUP BY 1", TABLES).ok


def test_accepts_cte_and_union():
    sql = """
    WITH top AS (SELECT * FROM sales WHERE amount > 100)
    SELECT region FROM top
    UNION ALL
    SELECT name FROM products
    """
    assert validate_sql(sql, TABLES).ok


def test_accepts_window_functions_and_joins():
    sql = """
    SELECT s.region, p.name,
           ROW_NUMBER() OVER (PARTITION BY s.region ORDER BY s.amount DESC) AS rn
    FROM sales s JOIN products p ON p.id = s.id
    """
    assert validate_sql(sql, TABLES).ok


def test_rejects_ddl_and_dml():
    for sql in [
        "DROP TABLE sales",
        "DELETE FROM sales",
        "INSERT INTO sales VALUES (1)",
        "UPDATE sales SET amount = 0",
        "CREATE TABLE evil AS SELECT * FROM sales",
    ]:
        result = validate_sql(sql, TABLES)
        assert not result.ok, sql


def test_rejects_multiple_statements():
    result = validate_sql("SELECT 1; SELECT 2", TABLES)
    assert not result.ok
    assert "one SQL statement" in result.error


def test_rejects_unknown_table():
    result = validate_sql("SELECT * FROM users", TABLES)
    assert not result.ok
    assert "users" in result.error


def test_cte_names_are_not_unknown_tables():
    sql = "WITH users AS (SELECT * FROM sales) SELECT * FROM users"
    assert validate_sql(sql, TABLES).ok


def test_rejects_unparseable_sql():
    result = validate_sql("SELEC region FRM sales", TABLES)
    assert not result.ok


def test_table_matching_is_case_insensitive():
    assert validate_sql("SELECT * FROM SALES", TABLES).ok


# -- allow_ctas (Phase 2 cleaning proposals) ----------------------------------


def test_ctas_rejected_by_default():
    sql = "CREATE TABLE sales_cleaned AS SELECT * FROM sales WHERE amount > 0"
    assert not validate_sql(sql, TABLES).ok


def test_ctas_accepted_when_allowed():
    sql = "CREATE TABLE sales_cleaned AS SELECT * FROM sales WHERE amount > 0"
    assert validate_sql(sql, TABLES, allow_ctas=True).ok


def test_ctas_cannot_overwrite_existing_table():
    sql = "CREATE OR REPLACE TABLE sales AS SELECT * FROM sales WHERE amount > 0"
    result = validate_sql(sql, TABLES, allow_ctas=True)
    assert not result.ok
    assert "overwrite" in result.error


def test_ctas_inner_query_tables_are_checked():
    sql = "CREATE TABLE cleaned AS SELECT * FROM users"
    result = validate_sql(sql, TABLES, allow_ctas=True)
    assert not result.ok
    assert "users" in result.error


def test_plain_create_table_rejected_even_when_ctas_allowed():
    result = validate_sql("CREATE TABLE t (a INTEGER)", TABLES, allow_ctas=True)
    assert not result.ok


def test_dml_still_rejected_when_ctas_allowed():
    for sql in ["DELETE FROM sales", "INSERT INTO sales VALUES (1)", "DROP TABLE sales"]:
        assert not validate_sql(sql, TABLES, allow_ctas=True).ok, sql
