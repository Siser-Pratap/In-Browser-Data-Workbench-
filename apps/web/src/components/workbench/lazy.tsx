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

// Split for the same reason as the rest, plus one specific to it: a build with
// no API configured never opens this dialog, so its chunk — and the generated
// API types it drags in — is never fetched at all.
export const LazyAskAiDialog = dynamic(
  () => import('@/components/ai/AskAiDialog').then((module) => module.AskAiDialog),
  { ssr: false },
);

// The analyst drags in the tool executor and the profiler on top of the API
// client, so it is the largest of the AI chunks — and the one most likely never
// to be opened in a given session.
export const LazyAnalystPanel = dynamic(
  () => import('@/components/ai/AnalystPanel').then((module) => module.AnalystPanel),
  { ssr: false, loading: () => Skeleton('Loading the analyst…') },
);

function Skeleton(label: string) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--color-ink-muted)]">
      {label}
    </div>
  );
}
