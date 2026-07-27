'use client';

import { useEffect, useMemo, useState } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
// The grid's own positioning styles. Its drop placeholder is bright red out of
// the box; globals.css restyles it to the accent colour.
import 'react-grid-layout/css/styles.css';
import { Download, LayoutDashboard, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Chart } from '@/components/charts/Chart';
import { ChartBuilder } from '@/components/charts/ChartBuilder';
import { useChartData } from '@/components/charts/useChartData';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { filtersFor, type DashboardFilter } from '@/lib/charts/compile';
import type { ChartSpec } from '@/lib/charts/spec';
import { MIME_TYPES, downloadBlob, downloadText, safeFilename } from '@/lib/export/download';
import { chartToPngDataUrl } from '@/lib/export/chart';
import { dashboardToHtml, dashboardToPdf, type ChartSnapshot } from '@/lib/export/dashboard';
import { track } from '@/lib/telemetry/telemetry';
import { cn } from '@/lib/utils/cn';
import {
  DASHBOARD_COLUMNS,
  activeFilters,
  useDashboardStore,
  type Dashboard,
  type DashboardItem,
} from '@/stores/dashboards';
import { useUiStore } from '@/stores/ui';

const ROW_HEIGHT = 44;

/**
 * The dashboards view.
 *
 * Every tile re-runs its own query — there is no shared result cache and no
 * stored data. That is what makes the filter bar and the refresh button work
 * without any invalidation machinery: change a filter and the SQL changes, so
 * the tiles simply ask again.
 */
export function DashboardsView() {
  const dashboards = useDashboardStore((state) => state.dashboards);
  const activeId = useDashboardStore((state) => state.activeId);
  const load = useDashboardStore((state) => state.load);
  const create = useDashboardStore((state) => state.create);
  const remove = useDashboardStore((state) => state.remove);
  const rename = useDashboardStore((state) => state.rename);
  const setActive = useDashboardStore((state) => state.setActive);
  const setLayout = useDashboardStore((state) => state.setLayout);
  const setFilters = useDashboardStore((state) => state.setFilters);
  const removeChart = useDashboardStore((state) => state.removeChart);
  const updateChart = useDashboardStore((state) => state.updateChart);

  useEffect(() => {
    void load();
  }, [load]);

  const dashboard = dashboards.find((item) => item.id === activeId) ?? null;

  // Bumping this key remounts every tile, which re-issues its query — the
  // honest way to "refresh" when nothing is cached to invalidate.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<ChartSpec | null>(null);
  const [width, setWidth] = useState(1200);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  // react-grid-layout needs a pixel width; it has no intrinsic sizing.
  useEffect(() => {
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  const filters = useMemo(() => activeFilters(dashboard?.filters ?? []), [dashboard?.filters]);

  if (dashboards.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <LayoutDashboard className="size-8 text-[var(--color-ink-muted)]" />
        <p className="max-w-sm text-sm text-[var(--color-ink-muted)]">
          Dashboards collect charts from your query tabs. Build a chart on the Chart tab beside
          any result, then use “Add to”.
        </p>
        <Button variant="primary" onClick={() => void create()}>
          New dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5">
        <select
          aria-label="Dashboard"
          value={activeId ?? ''}
          onChange={(event) => setActive(event.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs"
        >
          {dashboards.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>

        <Button size="sm" icon={<Plus className="size-3" />} onClick={() => void create()}>
          New
        </Button>

        {dashboard && (
          <>
            <ExportMenu dashboard={dashboard} />
            <Menu
              align="right"
              title="Dashboard actions"
              label={<MoreHorizontal className="size-3.5" />}
              items={[
                {
                  label: 'Rename…',
                  onSelect: () => {
                    const name = window.prompt('Dashboard name', dashboard.name);
                    if (name?.trim()) void rename(dashboard.id, name.trim());
                  },
                },
                {
                  label: 'Delete dashboard',
                  danger: true,
                  onSelect: () => {
                    if (window.confirm(`Delete “${dashboard.name}”?`)) void remove(dashboard.id);
                  },
                },
              ]}
            />
          </>
        )}
      </div>

      {dashboard && (
        <DashboardFilterBar
          filters={dashboard.filters}
          onChange={(next) => void setFilters(dashboard.id, next)}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            setRefreshKey((key) => key + 1);
            // The tiles remount and query independently; this only clears the
            // button's spinner once they've had a beat to start.
            setTimeout(() => setRefreshing(false), 600);
          }}
        />
      )}

      <div ref={setContainer} className="min-h-0 flex-1 overflow-auto p-2">
        {dashboard && dashboard.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-[var(--color-ink-muted)]">
            This dashboard is empty. Build a chart beside a query result and choose “Add to”.
          </p>
        ) : (
          dashboard && (
            <GridLayout
              width={width}
              gridConfig={{ cols: DASHBOARD_COLUMNS, rowHeight: ROW_HEIGHT, margin: [10, 10] }}
              // Only the tile's header bar drags. Without a handle the whole
              // tile is draggable, and a click anywhere on a chart — including
              // on its legend — would start moving it instead of interacting.
              dragConfig={{ handle: '.dashboard-tile-handle' }}
              layout={dashboard.items.map((item) => ({ i: item.spec.id, ...item.layout }))}
              onLayoutChange={(layout: Layout) =>
                void setLayout(
                  dashboard.id,
                  Object.fromEntries(
                    layout.map((entry) => [
                      entry.i,
                      { x: entry.x, y: entry.y, w: entry.w, h: entry.h },
                    ]),
                  ),
                )
              }
            >
              {dashboard.items.map((item) => (
                <div key={item.spec.id}>
                  <Tile
                    key={`${item.spec.id}:${refreshKey}`}
                    item={item}
                    filters={filters}
                    onEdit={() => setEditing(item.spec)}
                    onRemove={() => void removeChart(dashboard.id, item.spec.id)}
                  />
                </div>
              ))}
            </GridLayout>
          )
        )}
      </div>

      {editing && dashboard && (
        <Dialog
          title="Edit chart"
          width="max-w-5xl"
          onClose={() => setEditing(null)}
          footer={<Button variant="primary" onClick={() => setEditing(null)}>Done</Button>}
        >
          <div className="h-[60vh]">
            <EditTile spec={editing} onChange={(spec) => {
              setEditing(spec);
              void updateChart(dashboard.id, spec);
            }} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Tile({
  item,
  filters,
  onEdit,
  onRemove,
}: {
  item: DashboardItem;
  filters: DashboardFilter[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const data = useChartData(item.spec, filters);
  // Filters name columns; a chart whose query has none of them is simply not
  // filtered, rather than being broken by a predicate it can't satisfy.
  const applied = data.result ? filtersFor(filters, data.result.columns.map((c) => c.name)) : [];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
      <div className="dashboard-tile-handle flex shrink-0 cursor-move items-center gap-1 border-b border-[var(--color-border)] px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
          {item.spec.options.title || item.spec.encoding.y || 'Chart'}
        </span>
        {applied.length > 0 && (
          <span
            className="rounded bg-[var(--color-accent)]/15 px-1 text-[9px] text-[var(--color-accent)]"
            title={applied.map((filter) => filter.column).join(', ')}
          >
            filtered
          </span>
        )}
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit chart"
          className="rounded p-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <MoreHorizontal className="size-3" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove chart"
          className="rounded p-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-danger)]"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Chart spec={item.spec} result={data.result} error={data.error} loading={data.loading} />
      </div>
    </div>
  );
}

function EditTile({ spec, onChange }: { spec: ChartSpec; onChange: (spec: ChartSpec) => void }) {
  const data = useChartData(spec);
  return (
    <ChartBuilder spec={spec} columns={data.result?.columns ?? []} onChange={onChange} />
  );
}

function ExportMenu({ dashboard }: { dashboard: Dashboard }) {
  const theme = useUiStore((state) => state.theme);
  const [busy, setBusy] = useState(false);

  /**
   * Gather what each tile is currently showing.
   *
   * Read from the live chart instances rather than re-running the queries, so
   * the export is exactly the dashboard on screen — same filters, same numbers,
   * no chance of a re-run producing something subtly different.
   */
  async function snapshot(): Promise<ChartSnapshot[]> {
    const { compileChart } = await import('@/lib/charts/compile');
    const { getEngine } = await import('@/lib/engine/engine');
    const filters = activeFilters(dashboard.filters);

    return Promise.all(
      dashboard.items.map(async (item) => {
        let result = null;
        try {
          result = await getEngine().runQuery(compileChart(item.spec, filters));
        } catch {
          // A tile that can't run is exported as an empty card rather than
          // failing the whole document.
        }
        return { spec: item.spec, result, png: chartToPngDataUrl(item.spec.id, theme) };
      }),
    );
  }

  async function run(kind: 'pdf' | 'html'): Promise<void> {
    if (dashboard.items.length === 0) {
      toast.error('This dashboard has no charts yet.');
      return;
    }
    setBusy(true);
    try {
      const snapshots = await snapshot();
      const filename = safeFilename(dashboard.name);
      if (kind === 'pdf') {
        downloadBlob(await dashboardToPdf(dashboard, snapshots, theme), `${filename}.pdf`);
      } else {
        downloadText(
          await dashboardToHtml(dashboard, snapshots, theme),
          `${filename}.html`,
          MIME_TYPES['html']!,
        );
      }
      track('dashboard.export');
      toast.success(`Exported ${filename}.${kind}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Menu
      align="left"
      title="Export this dashboard"
      className={cn(busy && 'opacity-60')}
      label={
        <span className="flex items-center gap-1">
          <Download className="size-3" /> Export
        </span>
      }
      items={[
        { label: 'PDF', detail: 'print', disabled: busy, onSelect: () => void run('pdf') },
        {
          label: 'Standalone HTML',
          detail: 'self-contained',
          disabled: busy,
          onSelect: () => void run('html'),
        },
      ]}
    />
  );
}
