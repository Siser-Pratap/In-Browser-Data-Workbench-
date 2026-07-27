/**
 * The chart palette and chrome.
 *
 * The categorical hues and their **order** are load-bearing, not decorative:
 * the ordering is what keeps adjacent series distinguishable under
 * colour-vision deficiency. Both modes were validated against this app's own
 * chart surface (`--color-surface-raised`, #ffffff light / #22272e dark) with
 * the dataviz validator:
 *
 *   light — adjacent CVD ΔE 9.1, normal-vision ΔE 19.6, all bands pass
 *   dark  — adjacent CVD ΔE 8.4, normal-vision ΔE 19.3, all bands pass
 *
 * Three light-mode hues sit below 3:1 contrast on white. The documented relief
 * for that is "visible labels or a table view" — this app ships both: every
 * multi-series chart carries a legend, and the Results tab beside the chart is
 * the same data as a table, always one click away.
 *
 * Two rules the renderer must honour and the palette cannot enforce alone:
 * hues are assigned in fixed order and **never cycled** (a ninth series folds
 * into "Other" instead of inventing a colour), and all-pairs forms — scatter,
 * where any series can sit beside any other — cap at three series, because only
 * the first three slots clear the gates on every pair rather than on adjacent
 * ones.
 *
 * Regenerate after any change:
 *   node scripts/validate_palette.js "<hexes>" --mode light --surface "#ffffff"
 *   node scripts/validate_palette.js "<hexes>" --mode dark  --surface "#22272e"
 */

import type { Theme } from '@/stores/ui';
import { ALL_PAIRS_SERIES_CAP, isAllPairsForm, type ChartType, type NumberFormat } from './spec';

const CATEGORICAL_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

const CATEGORICAL_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

/** Chart chrome, matching the app's semantic tokens. */
export interface ChartChrome {
  surface: string;
  ink: string;
  inkMuted: string;
  grid: string;
  axis: string;
  categorical: readonly string[];
  /** One-hue ramp for magnitude — histograms and any single-measure form. */
  sequential: string;
}

const CHROME: Record<Theme, ChartChrome> = {
  light: {
    surface: '#ffffff',
    ink: '#1e2226',
    inkMuted: '#646a70',
    grid: '#e7e9ec',
    axis: '#dbdee1',
    categorical: CATEGORICAL_LIGHT,
    sequential: '#2a78d6',
  },
  dark: {
    surface: '#22272e',
    ink: '#eceff2',
    inkMuted: '#999fa8',
    grid: '#2c323a',
    axis: '#30363f',
    categorical: CATEGORICAL_DARK,
    sequential: '#3987e5',
  },
};

export function chromeFor(theme: Theme): ChartChrome {
  return CHROME[theme];
}

/** The most series a chart type may colour before folding the tail into "Other". */
export function seriesCapFor(type: ChartType): number {
  return isAllPairsForm(type) ? ALL_PAIRS_SERIES_CAP : CATEGORICAL_LIGHT.length;
}

/**
 * Assign colours to series names, in fixed slot order.
 *
 * Keyed by name rather than by index so a filter that removes a series doesn't
 * repaint the ones that remain — colour follows the entity, never its rank.
 */
export function assignColors(series: string[], theme: Theme): Map<string, string> {
  const { categorical } = CHROME[theme];
  const colors = new Map<string, string>();
  series.forEach((name, index) => {
    // Past the ceiling the caller has already folded the tail into "Other";
    // clamping here rather than cycling means a bug shows up as a repeated
    // last colour instead of a silently duplicated hue mid-palette.
    colors.set(name, categorical[Math.min(index, categorical.length - 1)]!);
  });
  return colors;
}

/** Label used for everything past the series cap. */
export const OTHER_SERIES = 'Other';

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

const COMPACT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const PLAIN = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

export function formatNumber(value: unknown, format: NumberFormat): string {
  if (value === null || value === undefined) return '—';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value);

  switch (format) {
    case 'compact':
      // Below a thousand, compact notation is just the number with less
      // precision — show the real value instead.
      return Math.abs(numeric) >= 1000 ? COMPACT.format(numeric) : PLAIN.format(numeric);
    case 'percent':
      return PERCENT.format(numeric);
    default:
      return PLAIN.format(numeric);
  }
}

/** Axis category labels: dates stay readable, long strings get elided. */
export function formatCategory(value: unknown, maxLength = 18): string {
  if (value === null || value === undefined) return '∅';
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
