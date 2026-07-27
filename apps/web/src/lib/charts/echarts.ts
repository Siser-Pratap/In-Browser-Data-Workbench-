/**
 * Chart spec + result → an ECharts option.
 *
 * The one place that knows about ECharts. Everything upstream — the spec, the
 * SQL, the reshaping — is renderer-agnostic, which is the whole reason for the
 * spec format.
 *
 * The mark specs here are deliberate and fixed rather than per-chart choices:
 * bars cap at 24px with a 4px rounded data-end and a square baseline, lines are
 * 2px, markers are at least 8px, area fills are a 10% wash, and touching fills
 * are separated by 2px of *surface colour* rather than by a stroke. Gridlines
 * are hairline and solid. Text always wears an ink token — never the series
 * colour, which is illegible at label sizes for the lighter hues.
 *
 * One rule has no code and still matters: there is never a second y-axis. Two
 * measures at different scales become two charts.
 */

import type { EChartsOption, LineSeriesOption } from 'echarts';

import type { Theme } from '@/stores/ui';
import {
  alignToCategories,
  canUseLogScale,
  shapeChart,
  SINGLE_SERIES,
  type ChartSeries,
} from './shape';
import type { ChartSpec } from './spec';
import { assignColors, chromeFor, formatCategory, formatNumber, seriesCapFor } from './theme';
import type { QueryResult } from '@/lib/engine/types';

const BAR_MAX_WIDTH = 24;
const LINE_WIDTH = 2;
const MARKER_SIZE = 8;
/** The surface gap/ring that separates touching marks. */
const SPACER = 2;
const AREA_OPACITY = 0.1;

export interface BuiltChart {
  option: EChartsOption;
  /** Set when series past the cap were folded, so the UI can say so. */
  folded: boolean;
}

export function buildOption(spec: ChartSpec, result: QueryResult, theme: Theme): BuiltChart {
  const chrome = chromeFor(theme);
  const { categories, series, folded } = shapeChart(result, seriesCapFor(spec.type));
  const named = series.map((entry) => ({
    ...entry,
    name: entry.name === SINGLE_SERIES ? spec.encoding.y ?? 'value' : entry.name,
  }));
  const colors = assignColors(
    named.map((entry) => entry.name),
    theme,
  );

  // A legend for two or more series, always: identity must never depend on
  // colour-matching alone. One series needs none — the title already names it.
  const showLegend = named.length >= 2 && spec.options.legend !== 'none';

  const base: EChartsOption = {
    backgroundColor: 'transparent',
    // A chart is drawn into a canvas, where the reduced-motion CSS in
    // globals.css can't reach it — so the preference has to be honoured here.
    animation: !prefersReducedMotion(),
    animationDuration: 300,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: chrome.ink },
    title: spec.options.title
      ? {
          text: spec.options.title,
          left: 8,
          top: 6,
          textStyle: { color: chrome.ink, fontSize: 13, fontWeight: 600 },
        }
      : undefined,
    legend: showLegend
      ? {
          type: 'scroll',
          ...legendPosition(spec.options.legend, Boolean(spec.options.title)),
          icon: 'roundRect',
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: chrome.inkMuted, fontSize: 11 },
        }
      : { show: false },
    tooltip: tooltipFor(spec, chrome),
    grid: {
      left: 12,
      right: 20,
      bottom: 8,
      top: gridTop(spec, showLegend),
      containLabel: true,
    },
  };

  switch (spec.type) {
    case 'pie':
      return { option: { ...base, ...pieOption(spec, named, chrome, theme) }, folded };
    case 'scatter':
      return { option: { ...base, ...scatterOption(spec, named, colors, chrome) }, folded };
    case 'histogram':
      return { option: { ...base, ...histogramOption(spec, named, chrome) }, folded };
    default:
      return {
        option: { ...base, ...cartesianOption(spec, named, categories, colors, chrome) },
        folded,
      };
  }
}

// ---------------------------------------------------------------------------

type Chrome = ReturnType<typeof chromeFor>;

function cartesianOption(
  spec: ChartSpec,
  series: ChartSeries[],
  categories: unknown[],
  colors: Map<string, string>,
  chrome: Chrome,
): EChartsOption {
  const stacked = spec.options.stacked && series.length > 1;
  const isBar = spec.type === 'bar';

  return {
    xAxis: {
      type: 'category',
      data: categories.map((category) => formatCategory(category)),
      name: spec.options.xLabel || undefined,
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: chrome.inkMuted, fontSize: 11 },
      axisLine: { lineStyle: { color: chrome.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: { color: chrome.inkMuted, fontSize: 11, hideOverlap: true },
      // Vertical gridlines add ink without adding information on a category axis.
      splitLine: { show: false },
    },
    yAxis: {
      type: yAxisType(spec, series),
      name: spec.options.yLabel || undefined,
      nameTextStyle: { color: chrome.inkMuted, fontSize: 11, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: chrome.inkMuted,
        fontSize: 11,
        formatter: (value: number) => formatNumber(value, spec.options.numberFormat),
      },
      splitLine: { lineStyle: { color: chrome.grid, width: 1, type: 'solid' } },
    },
    series: series.map((entry) => {
      const color = colors.get(entry.name)!;
      const data = alignToCategories(entry, categories);

      if (isBar) {
        return {
          type: 'bar' as const,
          name: entry.name,
          data,
          stack: stacked ? 'total' : undefined,
          barMaxWidth: BAR_MAX_WIDTH,
          // Air between neighbours; the band's leftover space is the point.
          barGap: '10%',
          barCategoryGap: '35%',
          itemStyle: {
            color,
            // Rounded at the data end, square at the baseline. A stacked
            // segment has neighbours on both sides, so it stays square and
            // relies on the surface gap below instead.
            borderRadius: stacked ? 0 : [4, 4, 0, 0],
            // The "gap" between touching fills is drawn as a border in the
            // surface colour — ECharts has no gap property, and a surface-
            // coloured edge is visually a gap rather than added data-ink.
            borderColor: stacked ? chrome.surface : 'transparent',
            borderWidth: stacked ? SPACER : 0,
          },
        };
      }

      const line: LineSeriesOption = {
        type: 'line',
        name: entry.name,
        data,
        stack: stacked && spec.type === 'area' ? 'total' : undefined,
        smooth: false,
        showSymbol: data.length <= 40,
        symbol: 'circle',
        symbolSize: MARKER_SIZE,
        lineStyle: { color, width: LINE_WIDTH, cap: 'round', join: 'round' },
        // The 2px surface ring keeps a marker legible where it crosses another
        // line or another marker.
        itemStyle: { color, borderColor: chrome.surface, borderWidth: SPACER },
        areaStyle: spec.type === 'area' ? { color, opacity: AREA_OPACITY } : undefined,
        connectNulls: false,
      };
      return line;
    }),
  };
}

function scatterOption(
  spec: ChartSpec,
  series: ChartSeries[],
  colors: Map<string, string>,
  chrome: Chrome,
): EChartsOption {
  const sizes = series.flatMap((entry) =>
    entry.points.map((point) => point.size).filter((size): size is number => size !== null && size !== undefined),
  );
  const maxSize = sizes.length > 0 ? Math.max(...sizes) : 0;

  return {
    xAxis: {
      type: 'value',
      name: spec.options.xLabel || spec.encoding.x || undefined,
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { color: chrome.inkMuted, fontSize: 11 },
      axisLine: { lineStyle: { color: chrome.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        color: chrome.inkMuted,
        fontSize: 11,
        formatter: (value: number) => formatNumber(value, spec.options.numberFormat),
      },
      splitLine: { lineStyle: { color: chrome.grid, width: 1, type: 'solid' } },
    },
    yAxis: {
      type: yAxisType(spec, series),
      name: spec.options.yLabel || spec.encoding.y || undefined,
      nameTextStyle: { color: chrome.inkMuted, fontSize: 11, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: chrome.inkMuted,
        fontSize: 11,
        formatter: (value: number) => formatNumber(value, spec.options.numberFormat),
      },
      splitLine: { lineStyle: { color: chrome.grid, width: 1, type: 'solid' } },
    },
    series: series.map((entry) => ({
      type: 'scatter' as const,
      name: entry.name,
      // ECharts reads a scatter point as [x, y, …extras]; the third slot is the
      // bubble value that `symbolSize` below maps to a radius.
      data: entry.points.map((point) => [
        toPlottable(point.x),
        point.y,
        point.size ?? null,
      ]),
      symbolSize: (value: unknown) => {
        const size = Array.isArray(value) ? Number(value[2]) : NaN;
        if (!maxSize || !Number.isFinite(size)) return MARKER_SIZE;
        // Area, not radius, scales with the value — a radius mapping
        // exaggerates large points by squaring the difference.
        return MARKER_SIZE + Math.sqrt(Math.max(0, size) / maxSize) * 20;
      },
      itemStyle: {
        color: colors.get(entry.name)!,
        opacity: 0.85,
        borderColor: chrome.surface,
        borderWidth: SPACER,
      },
    })),
  };
}

function histogramOption(spec: ChartSpec, series: ChartSeries[], chrome: Chrome): EChartsOption {
  const points = series[0]?.points ?? [];
  return {
    // A distribution has one measure, so it takes the sequential hue rather
    // than a categorical slot — more-is-darker is not in play, but the hue's
    // job here is magnitude, not identity.
    xAxis: {
      type: 'category',
      data: points.map((point) => formatNumber(point.x, spec.options.numberFormat)),
      name: spec.options.xLabel || spec.encoding.x || undefined,
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: chrome.inkMuted, fontSize: 11 },
      axisLine: { lineStyle: { color: chrome.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: { color: chrome.inkMuted, fontSize: 11, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: spec.options.yLabel || 'count',
      nameTextStyle: { color: chrome.inkMuted, fontSize: 11, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: chrome.inkMuted,
        fontSize: 11,
        formatter: (value: number) => formatNumber(value, 'compact'),
      },
      splitLine: { lineStyle: { color: chrome.grid, width: 1, type: 'solid' } },
    },
    series: [
      {
        type: 'bar',
        name: 'count',
        data: points.map((point) => point.y),
        barMaxWidth: BAR_MAX_WIDTH,
        // Histogram bins are contiguous by definition, so they touch — the 2px
        // surface edge is what keeps them countable.
        barCategoryGap: '2%',
        itemStyle: {
          color: chrome.sequential,
          borderRadius: [4, 4, 0, 0],
          borderColor: chrome.surface,
          borderWidth: SPACER,
        },
      },
    ],
  };
}

function pieOption(
  spec: ChartSpec,
  series: ChartSeries[],
  chrome: Chrome,
  theme: Theme,
): EChartsOption {
  // A pie's slices are its categories, not its series: one query row is one
  // slice, so the colour slot follows the x value rather than the series name.
  const points = series[0]?.points ?? [];
  const sliceColors = assignColors(points.map((point) => String(point.x)), theme);

  return {
    xAxis: undefined,
    yAxis: undefined,
    series: [
      {
        type: 'pie',
        radius: spec.options.donut ? ['45%', '72%'] : ['0%', '72%'],
        center: ['50%', '54%'],
        avoidLabelOverlap: true,
        data: points.map((point) => ({
          name: formatCategory(point.x, 24),
          value: point.y ?? 0,
          itemStyle: { color: sliceColors.get(String(point.x)) },
        })),
        itemStyle: {
          // Same surface spacer as everywhere else, wrapped round the arc.
          borderColor: chrome.surface,
          borderWidth: SPACER,
          borderRadius: 4,
        },
        label: {
          color: chrome.inkMuted,
          fontSize: 11,
          formatter: '{b}',
        },
        labelLine: { lineStyle: { color: chrome.axis } },
      },
    ],
  };
}

// ---------------------------------------------------------------------------

function tooltipFor(spec: ChartSpec, chrome: Chrome): EChartsOption['tooltip'] {
  const shared = {
    backgroundColor: chrome.surface,
    borderColor: chrome.axis,
    borderWidth: 1,
    textStyle: { color: chrome.ink, fontSize: 11 },
    extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,0.18); border-radius: 6px;',
  };

  // Line and area read as a whole vertical slice — a crosshair comparing every
  // series at one x is the useful reading. Discrete marks are read one at a
  // time.
  if (spec.type === 'line' || spec.type === 'area') {
    return {
      ...shared,
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: chrome.inkMuted },
        lineStyle: { color: chrome.inkMuted, width: 1 },
        label: { backgroundColor: chrome.inkMuted },
      },
      valueFormatter: (value: unknown) => formatNumber(value, spec.options.numberFormat),
    };
  }

  return {
    ...shared,
    trigger: 'item',
    valueFormatter: (value: unknown) => formatNumber(value, spec.options.numberFormat),
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Narrow an Arrow-derived cell to something an axis can place. */
function toPlottable(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' || typeof value === 'string' ? value : String(value);
}

function yAxisType(spec: ChartSpec, series: ChartSeries[]): 'value' | 'log' {
  // A log axis is undefined at zero and below, and ECharts renders the series
  // as a blank chart rather than complaining — so the option is ignored when
  // the data can't support it.
  return spec.options.logScale && canUseLogScale(series) ? 'log' : 'value';
}

function legendPosition(
  position: ChartSpec['options']['legend'],
  hasTitle: boolean,
): Record<string, number | string> {
  switch (position) {
    case 'right':
      return { orient: 'vertical', right: 8, top: 'middle' };
    case 'bottom':
      return { orient: 'horizontal', bottom: 0, left: 'center' };
    default:
      return { orient: 'horizontal', top: hasTitle ? 28 : 6, left: 'center' };
  }
}

function gridTop(spec: ChartSpec, showLegend: boolean): number {
  let top = spec.options.title ? 32 : 12;
  if (showLegend && spec.options.legend === 'top') top += 22;
  return top;
}
