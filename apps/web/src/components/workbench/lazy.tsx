'use client';

import dynamic from 'next/dynamic';

/**
 * The heavy views, split out of the initial bundle.
 *
 * The plan's budget is under 300 KB of initial JavaScript, and the landing
 * experience is a drop zone — someone who opens the app and looks at a CSV
 * should not have paid for Monaco, ECharts, or the dashboard grid. Each of these
 * is reachable only through an explicit action (switching view, opening a
 * builder), which is exactly the boundary a dynamic import wants.
 *
 * `ssr: false` throughout: all three touch `window` (an editor, a canvas, a
 * resize observer) and none of them has anything useful to say on the server.
 */

export const LazySqlWorkbench = dynamic(
  () => import('@/components/workbench/SqlWorkbench').then((module) => module.SqlWorkbench),
  { ssr: false, loading: () => Skeleton('Loading the editor…') },
);

export const LazyDashboardsView = dynamic(
  () => import('@/components/dashboards/DashboardView').then((module) => module.DashboardsView),
  { ssr: false, loading: () => Skeleton('Loading dashboards…') },
);

export const LazyChartBuilder = dynamic(
  () => import('@/components/charts/ChartBuilder').then((module) => module.ChartBuilder),
  { ssr: false, loading: () => Skeleton('Loading the chart builder…') },
);

export const LazyTransformDialog = dynamic(
  () => import('@/components/transform/TransformDialog').then((module) => module.TransformDialog),
  { ssr: false },
);

export const LazyColumnOpsDialog = dynamic(
  () => import('@/components/transform/ColumnOpsDialog').then((module) => module.ColumnOpsDialog),
  { ssr: false },
);

function Skeleton(label: string) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--color-ink-muted)]">
      {label}
    </div>
  );
}
