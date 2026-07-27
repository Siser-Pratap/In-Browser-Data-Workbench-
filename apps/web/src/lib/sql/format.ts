import { format } from 'sql-formatter';

/**
 * Pretty-print SQL in DuckDB's dialect.
 *
 * Formatting is a convenience, never a gate: `sql-formatter` tokenises the
 * input and throws on things it can't parse, and a half-typed query is exactly
 * when someone reaches for the Format button. So a failure returns the original
 * text unchanged rather than surfacing an error about the formatter — the
 * user's real syntax error is already being reported by the engine.
 */
export function formatSql(sql: string): string {
  try {
    return format(sql, {
      language: 'duckdb',
      keywordCase: 'upper',
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
  } catch {
    return sql;
  }
}
