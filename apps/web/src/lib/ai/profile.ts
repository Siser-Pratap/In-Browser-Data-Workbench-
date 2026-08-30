/**
 * Build the profile document the AI reads, in the browser, with SQL.
 *
 * This is the client half of the contract in `apps/api/src/app/ai/profile.py`,
 * whose docstring states the arrangement plainly: the browser computes the
 * profile and the model only ever sees these aggregates. So the expensive,
 * privacy-relevant part — reading every row — happens locally, and what crosses
 * the wire is a few hundred bytes of summary per column.
 *
 * All of it is computed in a **single query per table**, not one per column. A
 * 40-column table would otherwise mean 40 round trips through the worker, and
 * the agent profiles tables interactively while the user waits.
 */

import { getEngine } from '@/lib/engine/engine';
import { quoteIdent } from '@/lib/engine/types';
import type { ColumnSchema } from '@/lib/engine/types';
import type { ColumnProfile, TableProfile } from '@/lib/api/types';

/** Columns above this are summarised without top-values, to bound the payload. */
const TOP_VALUE_COLUMN_LIMIT = 40;
const TOP_VALUES_PER_COLUMN = 5;

export async function buildTableProfile(table: string): Promise<TableProfile> {
  const engine = getEngine();
  const columns = await engine.describeTable(table);
  if (columns.length === 0) {
    throw new Error(`Table ${table} has no columns.`);
  }

  const rowCount = await engine.countRows(table);
  const aggregates = await columnAggregates(table, columns, rowCount);

  // Top values need a GROUP BY per column, so they're the one thing that can't
  // ride along in the single aggregate query. Skipped entirely on very wide
  // tables — the marginal value to the model is low and the cost is linear.
  const wantTopValues = columns.length <= TOP_VALUE_COLUMN_LIMIT;
  const profiles: ColumnProfile[] = [];
  for (const column of columns) {
    const aggregate = aggregates[column.name] ?? {};
    const profile: ColumnProfile = {
      name: column.name,
      type: column.type,
      null_pct: aggregate.nullPct ?? 0,
      distinct_count: aggregate.distinctCount ?? null,
      distinct_pct:
        rowCount > 0 && aggregate.distinctCount != null
          ? round((aggregate.distinctCount / rowCount) * 100)
          : null,
    };

    if (column.kind === 'number' && aggregate.min != null) {
      profile.numeric = {
        min: aggregate.min,
        max: aggregate.max ?? null,
        mean: aggregate.mean ?? null,
        stddev: aggregate.stddev ?? null,
        p25: aggregate.p25 ?? null,
        p50: aggregate.p50 ?? null,
        p75: aggregate.p75 ?? null,
      };
    } else if (column.kind === 'date') {
      profile.temporal = { min: aggregate.minText ?? null, max: aggregate.maxText ?? null };
    }

    if (wantTopValues && (column.kind === 'string' || column.kind === 'boolean')) {
      profile.top_values = await topValues(table, column.name);
    }

    profiles.push(profile);
  }

  return {
    version: 1,
    table,
    row_count: rowCount,
    columns: profiles,
    candidate_keys: profiles
      .filter((column) => rowCount > 0 && column.distinct_count === rowCount)
      .map((column) => column.name),
    // Always false: this profile carries aggregates, never example rows. If a
    // sample is ever added it must flip this, because the server's prompt tells
    // the model whether it is looking at real values.
    sample_rows_included: false,
  };
}

interface Aggregate {
  nullPct?: number;
  distinctCount?: number;
  min?: number | null;
  max?: number | null;
  mean?: number | null;
  stddev?: number | null;
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  minText?: string | null;
  maxText?: string | null;
}

/**
 * One query, one row, every column's statistics as separate output columns.
 *
 * `approx_count_distinct` rather than an exact count for the same reason the
 * column-stats popover uses it: the agent profiles on demand and an exact
 * distinct count over a large table is the slowest thing here by far.
 */
async function columnAggregates(
  table: string,
  columns: ColumnSchema[],
  rowCount: number,
): Promise<Record<string, Aggregate>> {
  const selects: string[] = [];
  columns.forEach((column, index) => {
    const identifier = quoteIdent(column.name);
    selects.push(`count(${identifier})::BIGINT AS c${index}_nonnull`);
    selects.push(`approx_count_distinct(${identifier})::BIGINT AS c${index}_distinct`);
    if (column.kind === 'number') {
      selects.push(
        `min(${identifier})::DOUBLE AS c${index}_min`,
        `max(${identifier})::DOUBLE AS c${index}_max`,
        `avg(${identifier})::DOUBLE AS c${index}_mean`,
        `stddev_pop(${identifier})::DOUBLE AS c${index}_std`,
        `quantile_cont(${identifier}, 0.25)::DOUBLE AS c${index}_p25`,
        `quantile_cont(${identifier}, 0.5)::DOUBLE AS c${index}_p50`,
        `quantile_cont(${identifier}, 0.75)::DOUBLE AS c${index}_p75`,
      );
    } else if (column.kind === 'date') {
      selects.push(
        `min(${identifier})::VARCHAR AS c${index}_mintext`,
        `max(${identifier})::VARCHAR AS c${index}_maxtext`,
      );
    }
  });

  const result = await getEngine().query(
    `SELECT ${selects.join(', ')} FROM ${quoteIdent(table)}`,
  );
  const row = result.rows[0];
  const byName: Record<string, Aggregate> = {};
  if (!row) return byName;

  const cell = (index: number, suffix: string): unknown => {
    const position = result.columns.findIndex((column) => column.name === `c${index}_${suffix}`);
    return position === -1 ? null : row[position];
  };

  columns.forEach((column, index) => {
    const nonNull = num(cell(index, 'nonnull')) ?? 0;
    byName[column.name] = {
      nullPct: rowCount > 0 ? round(((rowCount - nonNull) / rowCount) * 100) : 0,
      distinctCount: num(cell(index, 'distinct')) ?? undefined,
      min: num(cell(index, 'min')),
      max: num(cell(index, 'max')),
      mean: num(cell(index, 'mean')),
      stddev: num(cell(index, 'std')),
      p25: num(cell(index, 'p25')),
      p50: num(cell(index, 'p50')),
      p75: num(cell(index, 'p75')),
      minText: text(cell(index, 'mintext')),
      maxText: text(cell(index, 'maxtext')),
    };
  });
  return byName;
}

async function topValues(
  table: string,
  column: string,
): Promise<{ value: string; count: number }[]> {
  try {
    const result = await getEngine().query(
      `SELECT ${quoteIdent(column)}::VARCHAR AS value, count(*)::BIGINT AS n
       FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL
       GROUP BY 1 ORDER BY n DESC, 1 LIMIT ${TOP_VALUES_PER_COLUMN}`,
    );
    return result.rows.map((row) => ({ value: String(row[0]), count: Number(row[1]) }));
  } catch {
    // Unorderable or uncastable type; the rest of the profile still stands.
    return [];
  }
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed) : null;
}

function text(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** Four decimals is well past what the model can use, and keeps the JSON small. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
