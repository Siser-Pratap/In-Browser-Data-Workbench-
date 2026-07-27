/**
 * No-code transformations, compiled to SQL.
 *
 * The plan's rule for this whole layer: the UI is a friendly front-end *over*
 * SQL, not a replacement for it. Every builder in the app produces a spec, this
 * module turns the spec into a SQL string, and that string is shown to the user
 * before it runs. Compilation is deliberately one-directional — there is no
 * SQL→spec parser — so the generated SQL is always the source of truth and can
 * be edited freely in the editor once it lands there.
 *
 * Keeping the generation here (pure, no React, no engine) is what makes it
 * testable against golden strings.
 */

import type { ColumnKind, ColumnSchema } from '@/lib/engine/types';
import { quoteIdent, quoteLiteral } from '@/lib/engine/types';

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type FilterOperator =
  | '='
  | '<>'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'is_null'
  | 'is_not_null';

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  '=': 'equals',
  '<>': 'does not equal',
  '>': 'greater than',
  '>=': 'greater or equal',
  '<': 'less than',
  '<=': 'less or equal',
  contains: 'contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  in: 'is one of',
  is_null: 'is empty',
  is_not_null: 'is not empty',
};

/** Operators that ignore the value input entirely. */
export const UNARY_OPERATORS: ReadonlySet<FilterOperator> = new Set(['is_null', 'is_not_null']);

export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  /** Raw text from the input; `in` takes a comma-separated list. */
  value: string;
}

export interface FilterSpec {
  kind: 'filter';
  table: string;
  combinator: 'AND' | 'OR';
  conditions: FilterCondition[];
}

export function compileFilter(spec: FilterSpec, columns: ColumnSchema[]): string {
  const usable = spec.conditions.filter(
    (condition) =>
      condition.column && (UNARY_OPERATORS.has(condition.operator) || condition.value !== ''),
  );
  const source = `SELECT * FROM ${quoteIdent(spec.table)}`;
  if (usable.length === 0) return source;

  const predicates = usable.map((condition) => renderCondition(condition, kindOf(columns, condition.column)));
  return `${source}\nWHERE ${predicates.join(`\n  ${spec.combinator} `)}`;
}

function renderCondition(condition: FilterCondition, kind: ColumnKind): string {
  const column = quoteIdent(condition.column);
  switch (condition.operator) {
    case 'is_null':
      return `${column} IS NULL`;
    case 'is_not_null':
      return `${column} IS NOT NULL`;
    case 'contains':
      return `${column} ILIKE ${quoteLiteral(`%${escapeLike(condition.value)}%`)}`;
    case 'starts_with':
      return `${column} ILIKE ${quoteLiteral(`${escapeLike(condition.value)}%`)}`;
    case 'ends_with':
      return `${column} ILIKE ${quoteLiteral(`%${escapeLike(condition.value)}`)}`;
    case 'in': {
      const items = condition.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => renderLiteral(item, kind));
      // An empty IN list is a syntax error; `IN (NULL)` matches nothing, which
      // is the honest reading of "is one of: nothing".
      return `${column} IN (${items.length > 0 ? items.join(', ') : 'NULL'})`;
    }
    default:
      return `${column} ${condition.operator} ${renderLiteral(condition.value, kind)}`;
  }
}

/**
 * Render a typed literal.
 *
 * Numbers and booleans go in bare so DuckDB compares them as numbers — quoting
 * `10` against a BIGINT column would compare it as text, where `'9' > '10'`.
 * Anything that doesn't look like the column's type falls back to a quoted
 * string and lets DuckDB decide, which produces a clear conversion error rather
 * than a silently wrong result.
 */
function renderLiteral(value: string, kind: ColumnKind): string {
  const trimmed = value.trim();
  if (kind === 'number' && trimmed !== '' && Number.isFinite(Number(trimmed))) return trimmed;
  if (kind === 'boolean') {
    const lowered = trimmed.toLowerCase();
    if (lowered === 'true' || lowered === 'false') return lowered;
  }
  return quoteLiteral(trimmed);
}

/** `%` and `_` are wildcards in LIKE; a user typing them means the characters. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function kindOf(columns: ColumnSchema[], name: string): ColumnKind {
  return columns.find((column) => column.name === name)?.kind ?? 'string';
}

// ---------------------------------------------------------------------------
// Derived columns
// ---------------------------------------------------------------------------

export interface DeriveSpec {
  kind: 'derive';
  table: string;
  /** Name of the new column. */
  name: string;
  /** A SQL scalar expression, typed by the user with a function palette. */
  expression: string;
}

export function compileDerive(spec: DeriveSpec): string {
  return (
    `SELECT *,\n  ${spec.expression.trim()} AS ${quoteIdent(spec.name)}\n` +
    `FROM ${quoteIdent(spec.table)}`
  );
}

/** Expression suggestions offered next to the derived-column input. */
export const EXPRESSION_PALETTE: { label: string; snippet: string; hint: string }[] = [
  { label: 'upper', snippet: 'upper(col)', hint: 'Uppercase text' },
  { label: 'lower', snippet: 'lower(col)', hint: 'Lowercase text' },
  { label: 'trim', snippet: 'trim(col)', hint: 'Strip surrounding whitespace' },
  { label: 'concat', snippet: "concat(a, ' ', b)", hint: 'Join values into one string' },
  { label: 'round', snippet: 'round(col, 2)', hint: 'Round a number' },
  { label: 'coalesce', snippet: 'coalesce(col, 0)', hint: 'Replace NULLs with a default' },
  { label: 'try_cast', snippet: 'try_cast(col AS DOUBLE)', hint: 'Convert, NULL if impossible' },
  { label: 'case', snippet: "CASE WHEN col > 0 THEN 'yes' ELSE 'no' END", hint: 'Conditional value' },
  { label: 'date_trunc', snippet: "date_trunc('month', col)", hint: 'Snap a date to a period' },
  { label: 'date_diff', snippet: "date_diff('day', a, b)", hint: 'Distance between two dates' },
  { label: 'regexp_extract', snippet: "regexp_extract(col, '(\\d+)', 1)", hint: 'Pull out a pattern' },
  { label: 'len', snippet: 'len(col)', hint: 'Length of text or list' },
];

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

export type AggregateFunction = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max' | 'median';

export const AGGREGATE_LABELS: Record<AggregateFunction, string> = {
  count: 'Count',
  count_distinct: 'Count distinct',
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  median: 'Median',
};

export interface Aggregation {
  fn: AggregateFunction;
  /** `*` is only meaningful for `count`. */
  column: string;
  alias?: string;
}

export interface AggregateSpec {
  kind: 'aggregate';
  table: string;
  groupBy: string[];
  aggregations: Aggregation[];
  /** Sort the summary by this output column, if set. */
  orderBy?: { column: string; descending: boolean } | null;
  limit?: number | null;
}

export function compileAggregate(spec: AggregateSpec): string {
  const aggregations = spec.aggregations.filter((aggregation) => aggregation.column);
  const selects = [
    ...spec.groupBy.map((column) => quoteIdent(column)),
    ...aggregations.map((aggregation) => {
      const alias = aggregation.alias?.trim() || defaultAlias(aggregation);
      return `${renderAggregate(aggregation)} AS ${quoteIdent(alias)}`;
    }),
  ];
  // A group-by with nothing selected is not a query; `count(*)` is the useful
  // default and matches what the builder shows before anything is configured.
  if (selects.length === 0) selects.push('count(*) AS "row_count"');

  const parts = [`SELECT ${selects.join(',\n       ')}`, `FROM ${quoteIdent(spec.table)}`];
  if (spec.groupBy.length > 0) {
    parts.push(`GROUP BY ${spec.groupBy.map((column) => quoteIdent(column)).join(', ')}`);
  }
  if (spec.orderBy?.column) {
    parts.push(`ORDER BY ${quoteIdent(spec.orderBy.column)} ${spec.orderBy.descending ? 'DESC' : 'ASC'}`);
  }
  if (spec.limit && spec.limit > 0) parts.push(`LIMIT ${Math.floor(spec.limit)}`);
  return parts.join('\n');
}

export function renderAggregate({ fn, column }: Aggregation): string {
  const target = column === '*' ? '*' : quoteIdent(column);
  if (fn === 'count_distinct') return `count(DISTINCT ${target})`;
  return `${fn}(${target})`;
}

export function defaultAlias({ fn, column }: Aggregation): string {
  if (column === '*') return fn === 'count' ? 'row_count' : fn;
  return `${fn}_${column}`;
}

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';

export interface JoinSpec {
  kind: 'join';
  left: string;
  right: string;
  type: JoinType;
  keys: { left: string; right: string }[];
}

export function compileJoin(spec: JoinSpec): string {
  const left = quoteIdent(spec.left);
  const right = quoteIdent(spec.right);
  // Alias the sides so identically-named columns in both tables are still
  // addressable; `SELECT l.*, r.*` keeps the duplicates visible instead of
  // letting one silently win.
  const header = `SELECT l.*, r.*\nFROM ${left} AS l`;

  if (spec.type === 'CROSS') return `${header}\nCROSS JOIN ${right} AS r`;

  const usable = spec.keys.filter((key) => key.left && key.right);
  if (usable.length === 0) {
    // Without keys this would be an accidental cartesian product on a table
    // that may have millions of rows, so refuse rather than generate it.
    return `${header}\n-- Pick at least one pair of join keys.`;
  }

  const conditions = usable
    .map((key) => `l.${quoteIdent(key.left)} = r.${quoteIdent(key.right)}`)
    .join('\n  AND ');
  return `${header}\n${spec.type} JOIN ${right} AS r\n  ON ${conditions}`;
}

// ---------------------------------------------------------------------------
// Column operations
// ---------------------------------------------------------------------------

export function compileRenameColumn(table: string, from: string, to: string): string {
  return `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`;
}

export function compileCastColumn(table: string, column: string, type: string): string {
  // TRY_CAST rather than a bare type change: an ALTER that hits one unparseable
  // value would abort and leave the user with an error instead of a column,
  // whereas TRY_CAST turns the bad rows into NULLs they can then find and fix.
  return (
    `ALTER TABLE ${quoteIdent(table)} ALTER COLUMN ${quoteIdent(column)} ` +
    `SET DATA TYPE ${type} USING TRY_CAST(${quoteIdent(column)} AS ${type})`
  );
}

export function compileDropColumn(table: string, column: string): string {
  return `ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(column)}`;
}

/** Reordering is a rewrite: SQL has no `ALTER TABLE … MOVE COLUMN`. */
export function compileReorderColumns(table: string, order: string[]): string {
  const projection = order.map((column) => quoteIdent(column)).join(', ');
  return `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT ${projection} FROM ${quoteIdent(table)}`;
}

/** DuckDB types offered in the cast dropdown. */
export const CAST_TARGET_TYPES = [
  'VARCHAR',
  'BIGINT',
  'INTEGER',
  'DOUBLE',
  'DECIMAL(18,4)',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'TIME',
  'JSON',
] as const;

// ---------------------------------------------------------------------------

export type TransformSpec = FilterSpec | DeriveSpec | AggregateSpec | JoinSpec;

/** Compile any transformation spec. Columns are only needed for typed literals. */
export function compileTransform(spec: TransformSpec, columns: ColumnSchema[] = []): string {
  switch (spec.kind) {
    case 'filter':
      return compileFilter(spec, columns);
    case 'derive':
      return compileDerive(spec);
    case 'aggregate':
      return compileAggregate(spec);
    case 'join':
      return compileJoin(spec);
    default: {
      const exhaustive: never = spec;
      throw new Error(`Unknown transformation: ${JSON.stringify(exhaustive)}`);
    }
  }
}
