/**
 * Reshaping a compiled chart result into series.
 *
 * `compile.ts` guarantees the result has `x`, `y` and (maybe) `series` columns,
 * so this is a fixed transformation with no knowledge of the user's schema. It
 * is separated from the renderer because the parts worth testing — the series
 * ordering, the "Other" fold, the sparse-category fill — have nothing to do with
 * ECharts.
 */

import type { QueryResult } from '@/lib/engine/types';

export interface ChartPoint {
  x: unknown;
  y: number | null;
  /** Scatter only. */
  size?: number | null;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

export interface ShapedChart {
  /** Distinct x values in the order the query returned them. */
  categories: unknown[];
  series: ChartSeries[];
  /** True when series past the cap were folded into "Other". */
  folded: boolean;
}

/** The name a chart with no `series` encoding uses for its single series. */
export const SINGLE_SERIES = '';

export function shapeChart(result: QueryResult, seriesCap: number): ShapedChart {
  const index = Object.fromEntries(result.columns.map((column, i) => [column.name, i]));
  const xIndex = index['x'];
  const yIndex = index['y'];
  const seriesIndex = index['series'];
  const sizeIndex = index['size'];

  const categories: unknown[] = [];
  const seen = new Set<string>();
  const byName = new Map<string, ChartPoint[]>();
  // Ranked by total magnitude so the fold keeps the series that matter and the
  // legend reads biggest-first.
  const magnitude = new Map<string, number>();

  for (const row of result.rows) {
    const x = xIndex === undefined ? null : row[xIndex];
    const y = toNumber(yIndex === undefined ? null : row[yIndex]);
    const name =
      seriesIndex === undefined || row[seriesIndex] === null || row[seriesIndex] === undefined
        ? SINGLE_SERIES
        : String(row[seriesIndex]);

    const key = String(x);
    if (!seen.has(key)) {
      seen.add(key);
      categories.push(x);
    }

    const points = byName.get(name) ?? [];
    points.push(
      sizeIndex === undefined
        ? { x, y }
        : { x, y, size: toNumber(row[sizeIndex]) },
    );
    byName.set(name, points);
    magnitude.set(name, (magnitude.get(name) ?? 0) + Math.abs(y ?? 0));
  }

  const ranked = [...byName.keys()].sort(
    (a, b) => (magnitude.get(b) ?? 0) - (magnitude.get(a) ?? 0),
  );

  if (ranked.length <= seriesCap) {
    return {
      categories,
      series: ranked.map((name) => ({ name, points: byName.get(name) ?? [] })),
      folded: false,
    };
  }

  // Past the cap, the tail becomes one "Other" series rather than a ninth
  // invented colour — a generated hue is indistinguishable from an existing one
  // under colour-vision deficiency.
  const kept = ranked.slice(0, seriesCap);
  const tail = ranked.slice(seriesCap);
  const otherByX = new Map<string, ChartPoint>();

  for (const name of tail) {
    for (const point of byName.get(name) ?? []) {
      const key = String(point.x);
      const existing = otherByX.get(key);
      if (existing) existing.y = (existing.y ?? 0) + (point.y ?? 0);
      else otherByX.set(key, { x: point.x, y: point.y });
    }
  }

  return {
    categories,
    series: [
      ...kept.map((name) => ({ name, points: byName.get(name) ?? [] })),
      { name: 'Other', points: [...otherByX.values()] },
    ],
    folded: true,
  };
}

/**
 * Align a series to the full category list.
 *
 * A grouped query only emits the (x, series) pairs that exist, so a series
 * missing a category would otherwise shift every later point one slot left and
 * silently misattribute its values.
 */
export function alignToCategories(series: ChartSeries, categories: unknown[]): (number | null)[] {
  const byX = new Map(series.points.map((point) => [String(point.x), point.y]));
  return categories.map((category) => byX.get(String(category)) ?? null);
}

/** True when a log scale is safe — it is undefined at and below zero. */
export function canUseLogScale(series: ChartSeries[]): boolean {
  return series.every((entry) =>
    entry.points.every((point) => point.y === null || point.y > 0),
  );
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
