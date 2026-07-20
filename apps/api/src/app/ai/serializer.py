"""Render table schemas into a compact prompt block.

The quality ceiling of NL->SQL is the schema context, but context is budgeted:
when the rendering exceeds the cap we degrade in priority order —
drop column stats, then sample values, then truncate column lists.
"""

from .schemas import TableSchema

_WIDE_TABLE_COLUMN_LIMIT = 60


def serialize_tables(tables: list[TableSchema], max_chars: int) -> str:
    for detail in ("full", "no_stats", "no_samples", "minimal"):
        rendered = "\n\n".join(_render_table(t, detail) for t in tables)
        if len(rendered) <= max_chars:
            return rendered
    return rendered[:max_chars]


def _render_table(table: TableSchema, detail: str) -> str:
    columns = table.columns
    truncated = 0
    if detail == "minimal" and len(columns) > _WIDE_TABLE_COLUMN_LIMIT:
        truncated = len(columns) - _WIDE_TABLE_COLUMN_LIMIT
        columns = columns[:_WIDE_TABLE_COLUMN_LIMIT]

    lines = [f"CREATE TABLE {_quote(table.name)} ("]
    for col in columns:
        parts = [f"  {_quote(col.name)} {col.type}"]
        annotations = []
        if detail == "full" and table.column_stats and col.name in table.column_stats:
            stats = table.column_stats[col.name]
            annotations.append(", ".join(f"{k}={v}" for k, v in stats.items()))
        if detail in ("full", "no_stats") and table.samples and col.name in table.samples:
            samples = ", ".join(repr(s) for s in table.samples[col.name][:8])
            annotations.append(f"e.g. {samples}")
        if annotations:
            parts.append(f"-- {'; '.join(annotations)}")
        lines.append(" ".join(parts) + ",")
    if lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]
    lines.append(");")
    if truncated:
        lines.append(f"-- ... {truncated} more columns omitted")
    if table.row_count is not None:
        lines.append(f"-- {table.row_count} rows")
    return "\n".join(lines)


def _quote(identifier: str) -> str:
    if identifier.isidentifier():
        return identifier
    return '"' + identifier.replace('"', '""') + '"'
