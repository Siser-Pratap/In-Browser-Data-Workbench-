/**
 * Schema-aware completion candidates.
 *
 * Kept as a pure function over (text-before-cursor, catalogue) rather than
 * living inside a Monaco provider, so the interesting behaviour — alias
 * resolution, qualified vs unqualified context, ranking — is unit-testable
 * without booting an editor.
 */

import type { CatalogTable } from '@/lib/engine/types';

export type CompletionKind = 'table' | 'column' | 'keyword' | 'function' | 'snippet';

export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
  /** Text to insert when it differs from the label (quoted identifiers). */
  insertText?: string;
  /** Lower sorts first; used to float schema items above keywords. */
  rank: number;
}

export interface CompletionContext {
  /** The whole editor buffer. */
  sql: string;
  /** Cursor offset within it. */
  offset: number;
  catalog: CatalogTable[];
  snippets?: { name: string; sql: string }[];
}

export function completionsFor({
  sql,
  offset,
  catalog,
  snippets = [],
}: CompletionContext): Completion[] {
  const textBeforeCursor = sql.slice(0, offset);
  const qualifier = qualifierBeforeCursor(textBeforeCursor);

  if (qualifier) {
    // `alias.` or `table.` — only that table's columns make sense here, and
    // offering keywords as well would bury them.
    //
    // Aliases come from the *whole* buffer, not just the text to the left:
    // people routinely type `SELECT o.` before they have written the FROM
    // clause, or go back to add a column to a finished query.
    const aliases = resolveAliases(sql, catalog);
    const table = aliases.get(qualifier.toLowerCase()) ?? qualifier;
    const match = catalog.find((entry) => entry.name.toLowerCase() === table.toLowerCase());
    return (match?.columns ?? []).map((column) => ({
      label: column.name,
      kind: 'column' as const,
      detail: `${column.type} · ${match?.name ?? table}`,
      insertText: identifier(column.name),
      rank: 0,
    }));
  }

  const completions: Completion[] = [];

  for (const table of catalog) {
    completions.push({
      label: table.name,
      kind: 'table',
      detail: `table · ${table.columns.length} columns`,
      insertText: identifier(table.name),
      rank: 0,
    });
  }

  // Columns from every table, de-duplicated by name. A name in several tables
  // gets one entry listing them all — better than five identical rows.
  const columnTables = new Map<string, { type: string; tables: string[] }>();
  for (const table of catalog) {
    for (const column of table.columns) {
      const existing = columnTables.get(column.name);
      if (existing) existing.tables.push(table.name);
      else columnTables.set(column.name, { type: column.type, tables: [table.name] });
    }
  }
  for (const [name, { type, tables }] of columnTables) {
    completions.push({
      label: name,
      kind: 'column',
      detail: `${type} · ${tables.join(', ')}`,
      insertText: identifier(name),
      rank: 1,
    });
  }

  for (const snippet of snippets) {
    completions.push({ label: snippet.name, kind: 'snippet', detail: 'saved snippet', insertText: snippet.sql, rank: 2 });
  }

  for (const keyword of DUCKDB_KEYWORDS) {
    completions.push({ label: keyword, kind: 'keyword', rank: 3 });
  }
  for (const [name, detail] of DUCKDB_FUNCTIONS) {
    completions.push({ label: name, kind: 'function', detail, insertText: `${name}($0)`, rank: 4 });
  }

  return completions;
}

/** The identifier immediately before a trailing `.`, or null. */
function qualifierBeforeCursor(text: string): string | null {
  const match = /(?:"([^"]+)"|([A-Za-z_]\w*))\.\w*$/.exec(text);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Map `FROM orders AS o` / `JOIN users u` to the tables they alias.
 *
 * Deliberately regex-based rather than a parser: the text under the cursor is
 * usually a half-written query that no parser would accept, and the failure mode
 * of a missed alias (falling back to treating it as a table name) is harmless.
 */
export function resolveAliases(sql: string, catalog: CatalogTable[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const table of catalog) aliases.set(table.name.toLowerCase(), table.name);

  const pattern = /\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([A-Za-z_]\w*))(?:\s+(?:AS\s+)?(?!ON\b|USING\b|WHERE\b|GROUP\b|ORDER\b|LIMIT\b|HAVING\b|JOIN\b|LEFT\b|RIGHT\b|INNER\b|FULL\b|CROSS\b)([A-Za-z_]\w*))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1] ?? match[2];
    const alias = match[3];
    if (table && alias) aliases.set(alias.toLowerCase(), table);
  }
  return aliases;
}

/** Quote an identifier only when it needs it — quoted SQL is noisy to read. */
export function identifier(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase())
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

const DUCKDB_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'WITH', 'AS', 'DISTINCT', 'DISTINCT ON', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ILIKE',
  'IS NULL', 'IS NOT NULL', 'EXISTS', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
  'CREATE TABLE', 'CREATE OR REPLACE TABLE', 'CREATE VIEW', 'DROP TABLE', 'ALTER TABLE',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'VALUES', 'DESCRIBE', 'SUMMARIZE', 'EXPLAIN',
  'PIVOT', 'UNPIVOT', 'QUALIFY', 'WINDOW', 'OVER', 'PARTITION BY', 'FILTER',
  'CAST', 'TRY_CAST', 'COPY', 'SAMPLE', 'USING SAMPLE', 'EXCLUDE', 'REPLACE',
] as const;

const RESERVED = new Set<string>(DUCKDB_KEYWORDS.flatMap((keyword) => keyword.split(' ')));

/** A working set of DuckDB functions — the ones an analyst reaches for. */
const DUCKDB_FUNCTIONS: [string, string][] = [
  ['count', 'count(*) — number of rows'],
  ['sum', 'sum(x) — total'],
  ['avg', 'avg(x) — mean'],
  ['min', 'min(x)'],
  ['max', 'max(x)'],
  ['median', 'median(x)'],
  ['quantile_cont', 'quantile_cont(x, 0.95) — interpolated percentile'],
  ['stddev', 'stddev(x) — sample standard deviation'],
  ['mode', 'mode(x) — most frequent value'],
  ['any_value', 'any_value(x) — an arbitrary non-null value'],
  ['list', 'list(x) — collect into a list'],
  ['string_agg', "string_agg(x, ', ') — concatenate group values"],
  ['approx_count_distinct', 'approx_count_distinct(x) — fast cardinality estimate'],
  ['row_number', 'row_number() OVER (…)'],
  ['rank', 'rank() OVER (…)'],
  ['dense_rank', 'dense_rank() OVER (…)'],
  ['lag', 'lag(x, 1) OVER (…) — previous row'],
  ['lead', 'lead(x, 1) OVER (…) — next row'],
  ['first_value', 'first_value(x) OVER (…)'],
  ['ntile', 'ntile(4) OVER (…) — bucket rows'],
  ['coalesce', 'coalesce(a, b) — first non-null'],
  ['nullif', 'nullif(a, b) — null when equal'],
  ['ifnull', 'ifnull(a, b)'],
  ['upper', 'upper(s)'],
  ['lower', 'lower(s)'],
  ['trim', 'trim(s)'],
  ['length', 'length(s)'],
  ['substring', 'substring(s, 1, 3)'],
  ['replace', 'replace(s, from, to)'],
  ['split_part', "split_part(s, ',', 1)"],
  ['concat', 'concat(a, b)'],
  ['concat_ws', "concat_ws('-', a, b)"],
  ['regexp_matches', "regexp_matches(s, '^a')"],
  ['regexp_extract', "regexp_extract(s, '(\\d+)', 1)"],
  ['regexp_replace', 'regexp_replace(s, pattern, to)'],
  ['strftime', "strftime(t, '%Y-%m')"],
  ['strptime', "strptime(s, '%Y-%m-%d')"],
  ['date_trunc', "date_trunc('month', t)"],
  ['date_diff', "date_diff('day', a, b)"],
  ['date_part', "date_part('year', t)"],
  ['current_date', 'current_date'],
  ['now', 'now()'],
  ['epoch_ms', 'epoch_ms(t) — milliseconds since 1970'],
  ['round', 'round(x, 2)'],
  ['floor', 'floor(x)'],
  ['ceil', 'ceil(x)'],
  ['abs', 'abs(x)'],
  ['greatest', 'greatest(a, b)'],
  ['least', 'least(a, b)'],
  ['read_csv', "read_csv('file.csv')"],
  ['read_parquet', "read_parquet('file.parquet')"],
  ['read_json_auto', "read_json_auto('file.json')"],
];
