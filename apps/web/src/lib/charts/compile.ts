/**
 * Chart spec → SQL.
 *
 * Every chart is a query. The aggregation, the top-N cut, the histogram
 * bucketing and the scatter downsample all happen inside DuckDB, so what
 * crosses into JavaScript is already the handful of rows the chart draws. That
 * is what makes "a dashboard with six charts over a 5M-row table in under three
 * seconds" a reasonable target rather than a wish — the browser never touches
 * five million anything.
 *
 * The generated query always projects the same three column names — `x`, `y`
 * and `series` — so the renderer reads a fixed shape and doesn't have to know
 * anything about the user's schema.
 */

import { quoteIdent, quoteLiteral } from '@/lib/engine/types';
import { stripTrailingSemicolon } from '@/lib/engine/engine';
import { renderAggregate } from '@/lib/sql/transform';
import { RAW_POINT_CAP, aggregates, type ChartSpec } from './spec';

/** A dashboard-level filter, injected into every member chart that can take it. */
export type DashboardFilter =
  | { kind: 'date-range'; column: string; from: string; to: string }
  | { kind: 'equals'; column: string; value: string };

export class ChartCompileError extends Error {}

export function compileChart(spec: ChartSpec, filters: DashboardFilter[] = []): string {
  const { encoding, options, type } = spec;
  const source = `WITH source AS (\n${indent(stripTrailingSemicolon(spec.query))}\n)`;
  const where = renderFilters(filters);

  if (type === 'table') {
    return `${source}\nSELECT * FROM source${where}\nLIMIT ${limitOf(options.limit)}`;
  }

  if (type === 'kpi') {
    if (!encoding.y) throw new ChartCompileError('Choose a value to summarise.');
    const measure =
      encoding.aggregate === 'none'
        ? quoteIdent(encoding.y)
        : renderAggregate({ fn: encoding.aggregate, column: encoding.y });
    return `${source}\nSELECT ${measure} AS "y"\nFROM source${where}`;
  }

  if (type === 'histogram') {
    if (!encoding.x) throw new ChartCompileError('Choose a numeric column to bucket.');
    return compileHistogram(spec, source, where);
  }

  if (!encoding.x) throw new ChartCompileError('Choose a column for the horizontal axis.');
  if (!encoding.y) throw new ChartCompileError('Choose a column for the vertical axis.');

  const x = quoteIdent(encoding.x);
  const y = quoteIdent(encoding.y);
  const series = encoding.series ? quoteIdent(encoding.series) : null;

  if (!aggregates(type)) {
    // Scatter: raw points. The cap is a `USING SAMPLE` rather than a `LIMIT`
    // because the first N rows of a table are not a picture of it — a sample is.
    const columns = [
      `${x} AS "x"`,
      `${y} AS "y"`,
      series ? `${series}::VARCHAR AS "series"` : `NULL AS "series"`,
      encoding.size ? `${quoteIdent(encoding.size)} AS "size"` : `NULL AS "size"`,
    ];
    const cap = Math.min(limitOf(options.limit), RAW_POINT_CAP);
    return (
      `${source}\nSELECT ${columns.join(',\n       ')}\n` +
      `FROM source${where}\nUSING SAMPLE ${cap} ROWS`
    );
  }

  const measure =
    encoding.aggregate === 'none'
      ? y
      : renderAggregate({ fn: encoding.aggregate, column: encoding.y });

  const selects = [`${x} AS "x"`, `${measure} AS "y"`];
  const groupBy = ['1'];
  if (series) {
    selects.splice(1, 0, `${series}::VARCHAR AS "series"`);
    groupBy.push('2');
  }

  // Time reads left-to-right; everything else is a ranking, so the biggest bar
  // goes first. Ordering by the measure is also what makes the LIMIT a
  // meaningful "top N" rather than an arbitrary slice.
  const order = isTemporalOrder(spec) ? `ORDER BY "x"` : `ORDER BY "y" DESC`;

  return (
    `${source}\nSELECT ${selects.join(',\n       ')}\n` +
    `FROM source${where}\n` +
    (encoding.aggregate === 'none' ? '' : `GROUP BY ${groupBy.join(', ')}\n`) +
    `${order}\nLIMIT ${limitOf(options.limit)}`
  );
}

/**
 * Bucket a numeric column.
 *
 * The bounds come from the data in the same statement rather than from a prior
 * round-trip, so a histogram is one query. `width_bucket` puts each row in a
 * bucket and the arithmetic turns the bucket index back into the value at its
 * left edge, which is what the axis should show.
 */
function compileHistogram(spec: ChartSpec, source: string, where: string): string {
  const column = quoteIdent(spec.encoding.x!);
  const bins = Math.max(2, Math.min(200, Math.floor(spec.options.bins)));

  return (
    `${source},\n` +
    `bounds AS (SELECT min(${column}) AS lo, max(${column}) AS hi FROM source${where})\n` +
    `SELECT bounds.lo + (width_bucket(source.${column}, bounds.lo, bounds.hi, ${bins}) - 1)\n` +
    `         * (bounds.hi - bounds.lo) / ${bins} AS "x",\n` +
    `       count(*) AS "y",\n` +
    `       NULL AS "series"\n` +
    `FROM source, bounds\n` +
    `WHERE source.${column} IS NOT NULL\n` +
    `GROUP BY 1\n` +
    `ORDER BY 1`
  );
}

/**
 * Dashboard filters as a WHERE clause.
 *
 * Filters name a column, and a dashboard's charts don't all have it — so a
 * filter whose column is absent simply doesn't apply to that chart. That's
 * decided by the caller (`filtersFor`), because only it knows each chart's
 * columns; anything reaching here is expected to be applicable.
 */
function renderFilters(filters: DashboardFilter[]): string {
  if (filters.length === 0) return '';
  const predicates = filters.map((filter) => {
    const column = quoteIdent(filter.column);
    if (filter.kind === 'equals') return `${column} = ${quoteLiteral(filter.value)}`;
    return (
      `${column} BETWEEN ${quoteLiteral(filter.from)}::TIMESTAMP ` +
      `AND ${quoteLiteral(filter.to)}::TIMESTAMP`
    );
  });
  return `\nWHERE ${predicates.join('\n  AND ')}`;
}

/** Drop filters whose column the chart's result doesn't have. */
export function filtersFor(filters: DashboardFilter[], columns: string[]): DashboardFilter[] {
  const available = new Set(columns);
  return filters.filter((filter) => available.has(filter.column));
}

function isTemporalOrder(spec: ChartSpec): boolean {
  return spec.type === 'line' || spec.type === 'area';
}

function limitOf(limit: number): number {
  return Math.max(1, Math.min(RAW_POINT_CAP, Math.floor(limit) || 50));
}

function indent(sql: string): string {
  return sql
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
