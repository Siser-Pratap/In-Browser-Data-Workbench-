'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ECharts as EChartsInstance } from 'echarts/core';
import { AlertCircle, Loader2 } from 'lucide-react';

import { ResultsGrid } from '@/components/grid/ResultsGrid';
import { buildOption } from '@/lib/charts/echarts';
import { loadECharts } from '@/lib/charts/echarts-loader';
import { registerChart, unregisterChart } from '@/lib/charts/registry';
import type { ChartSpec } from '@/lib/charts/spec';
import { formatNumber } from '@/lib/charts/theme';
import type { QueryResult } from '@/lib/engine/types';
import { useUiStore } from '@/stores/ui';

interface Props {
  spec: ChartSpec;
  result: QueryResult | null;
  error?: string | null;
  loading?: boolean;
}

/**
 * One chart, rendered from a spec and a result.
 *
 * Two of the "chart types" aren't ECharts at all. A big number is a stat tile,
 * because a one-bar bar chart communicates less than the number itself; and a
 * table is the grid, which is also the accessibility relief for the light-mode
 * hues that sit below 3:1 contrast — the same data, readable without colour.
 */
export function Chart({ spec, result, error, loading }: Props) {
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="flex max-w-sm items-start gap-2 text-xs text-[var(--color-danger)]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      </div>
    );
  }

  if (loading || !result) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Loader2 className="size-3.5 animate-spin" /> Building chart…
      </div>
    );
  }

  if (spec.type === 'table') return <ResultsGrid result={result} />;
  if (spec.type === 'kpi') return <BigNumber spec={spec} result={result} />;

  return <EChart spec={spec} result={result} />;
}

/**
 * The hero figure.
 *
 * Proportional figures at a large size, the label in secondary ink above it —
 * a single number that leads a dashboard should read as a headline, not as a
 * chart axis.
 */
function BigNumber({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  const value = result.rows[0]?.[0] ?? null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-xs text-[var(--color-ink-muted)]">
        {spec.options.title || spec.options.yLabel || spec.encoding.y || 'Value'}
      </p>
      <p className="text-4xl leading-none font-semibold tabular-nums">
        {formatNumber(value, spec.options.numberFormat)}
      </p>
    </div>
  );
}

function EChart({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsInstance | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useUiStore((state) => state.theme);

  useEffect(() => {
    let disposed = false;
    const id = spec.id;

    void loadECharts().then((echarts) => {
      if (disposed || !container.current) return;
      const chart = echarts.init(container.current, undefined, { renderer: 'canvas' });
      instance.current = chart;
      registerChart(id, chart);
      setReady(true);
    });

    return () => {
      disposed = true;
      unregisterChart(id);
      instance.current?.dispose();
      instance.current = null;
    };
  }, [spec.id]);

  // ECharts sizes itself to its container once, at init; a grid-layout resize or
  // a sidebar toggle would otherwise leave it drawn at the old dimensions.
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => instance.current?.resize());
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready]);

  const { option, folded } = useMemo(
    () => buildOption(spec, result, theme),
    [spec, result, theme],
  );

  useEffect(() => {
    // `notMerge` because changing the chart type replaces the series entirely;
    // merging would leave the previous type's series alongside the new one.
    instance.current?.setOption(option, { notMerge: true });
  }, [option, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" data-testid="echart" data-chart-id={spec.id} />
      {folded && (
        <p className="absolute right-2 bottom-1 text-[10px] text-[var(--color-ink-muted)]">
          smaller series grouped as “Other”
        </p>
      )}
    </div>
  );
}
