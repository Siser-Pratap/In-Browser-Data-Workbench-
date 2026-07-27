/**
 * The chart spec.
 *
 * A chart is a small JSON document, not an ECharts option object. That
 * indirection buys three things the plan asks for: the spec can be persisted and
 * diffed, it maps one-to-one onto the encoding panel's controls, and the
 * renderer underneath it can be replaced without touching anything that was
 * saved. It is versioned for the same reason.
 *
 * Crucially the spec owns a **SQL query**, not data. Nothing is ever aggregated
 * in JavaScript — see `compile.ts` — so a chart over a 10M-row table costs the
 * same as one over a thousand.
 */

import type { ColumnSchema } from '@/lib/engine/types';
import type { AggregateFunction } from '@/lib/sql/transform';

export type ChartType =
  | 'bar'
  | 'line'
  | 'area'
  | 'scatter'
  | 'pie'
  | 'histogram'
  | 'kpi'
  | 'table';

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie / donut',
  histogram: 'Histogram',
  kpi: 'Big number',
  table: 'Table',
};

/** `none` means "plot the rows as they are" — no GROUP BY. */
export type ChartAggregate = AggregateFunction | 'none';

export interface ChartEncoding {
  /** Category or time axis. Unused by `kpi`. */
  x: string | null;
  /** The measure. Unused by `table`. */
  y: string | null;
  aggregate: ChartAggregate;
  /** Splits the measure into one series per distinct value. */
  series: string | null;
  /** Scatter only — bubble radius. */
  size: string | null;
}

export type NumberFormat = 'plain' | 'compact' | 'percent';

export interface ChartOptions {
  title: string;
  xLabel: string;
  yLabel: string;
  legend: 'top' | 'right' | 'bottom' | 'none';
  numberFormat: NumberFormat;
  logScale: boolean;
  /** Bar/area only. */
  stacked: boolean;
  /** Histogram only. */
  bins: number;
  /** Pie only — renders as a donut when true. */
  donut: boolean;
  /** Cap on marks. Applied in SQL, so the browser never sees more. */
  limit: number;
}

export interface ChartSpec {
  /** Bumped if the shape ever changes incompatibly; readers check it. */
  version: 1;
  id: string;
  type: ChartType;
  /** The query the chart aggregates over, as a subquery-safe SELECT. */
  query: string;
  encoding: ChartEncoding;
  options: ChartOptions;
}

/**
 * The raw-point ceiling for un-aggregated charts.
 *
 * DuckDB does the sampling (`USING SAMPLE`), so this bounds what crosses into
 * JavaScript, not what the engine scans. Ten thousand points is already more
 * than a scatter plot can show distinctly; past it the browser is paying to
 * render overplotting.
 */
export const RAW_POINT_CAP = 10_000;

/**
 * Series ceiling for all-pairs forms.
 *
 * The validated categorical palette clears the colour-blindness gates on *all*
 * pairs only for its first three slots — which is exactly the case a scatter
 * plot creates, since every series can sit next to every other. Adjacent forms
 * (bars, lines, stacks) are safe to eight. See `theme.ts`.
 */
export const ALL_PAIRS_SERIES_CAP = 3;

export const DEFAULT_OPTIONS: ChartOptions = {
  title: '',
  xLabel: '',
  yLabel: '',
  legend: 'top',
  numberFormat: 'compact',
  logScale: false,
  stacked: false,
  bins: 30,
  donut: false,
  limit: 50,
};

/** Chart types that group in SQL rather than plotting raw rows. */
export function aggregates(type: ChartType): boolean {
  return type !== 'scatter' && type !== 'table' && type !== 'histogram';
}

/** Chart types where every series can appear beside every other. */
export function isAllPairsForm(type: ChartType): boolean {
  return type === 'scatter';
}

/**
 * Guess a chart from the result's column types.
 *
 * The plan's rule, made concrete: a temporal x-axis wants a line, a category
 * plus a number wants bars, and two numbers want a scatter. The point isn't to
 * be clever — it's that the first chart a user sees should already be roughly
 * right, so the encoding panel is for refining rather than for starting from
 * nothing.
 */
export function inferSpec(id: string, query: string, columns: ColumnSchema[]): ChartSpec {
  const temporal = columns.find((column) => column.kind === 'date');
  const numbers = columns.filter((column) => column.kind === 'number');
  const categories = columns.filter(
    (column) => column.kind === 'string' || column.kind === 'boolean',
  );

  const options = { ...DEFAULT_OPTIONS };

  // A lone number and nothing to break it down by is a headline, not a chart.
  if (numbers.length === 1 && categories.length === 0 && !temporal) {
    return {
      version: 1,
      id,
      type: 'kpi',
      query,
      encoding: { x: null, y: numbers[0]!.name, aggregate: 'sum', series: null, size: null },
      options,
    };
  }

  if (temporal && numbers.length > 0) {
    return {
      version: 1,
      id,
      type: 'line',
      query,
      encoding: {
        x: temporal.name,
        y: numbers[0]!.name,
        aggregate: 'sum',
        series: categories[0]?.name ?? null,
        // A time axis wants every point, not the top 50 by value.
        size: null,
      },
      options: { ...options, limit: 500 },
    };
  }

  if (categories.length > 0 && numbers.length > 0) {
    return {
      version: 1,
      id,
      type: 'bar',
      query,
      encoding: {
        x: categories[0]!.name,
        y: numbers[0]!.name,
        aggregate: 'sum',
        series: categories[1]?.name ?? null,
        size: null,
      },
      options: { ...options, stacked: categories.length > 1 },
    };
  }

  if (numbers.length >= 2) {
    return {
      version: 1,
      id,
      type: 'scatter',
      query,
      encoding: {
        x: numbers[0]!.name,
        y: numbers[1]!.name,
        aggregate: 'none',
        series: categories[0]?.name ?? null,
        size: numbers[2]?.name ?? null,
      },
      options: { ...options, limit: RAW_POINT_CAP },
    };
  }

  if (numbers.length === 1) {
    return {
      version: 1,
      id,
      type: 'histogram',
      query,
      encoding: { x: numbers[0]!.name, y: null, aggregate: 'none', series: null, size: null },
      options,
    };
  }

  // Nothing numeric to plot: show the rows and say so.
  return {
    version: 1,
    id,
    type: 'table',
    query,
    encoding: {
      x: columns[0]?.name ?? null,
      y: null,
      aggregate: 'none',
      series: null,
      size: null,
    },
    options,
  };
}
