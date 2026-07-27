'use client';

import { create } from 'zustand';

import type { DashboardFilter } from '@/lib/charts/compile';
import type { ChartSpec } from '@/lib/charts/spec';
import * as idb from '@/lib/storage/idb';
import { track } from '@/lib/telemetry/telemetry';
import { newId } from '@/lib/utils/id';

/**
 * Dashboards.
 *
 * A dashboard stores **chart specs**, not chart data — so opening one re-runs
 * every query against whatever is in the engine now. That's what makes
 * "re-import a newer file and the dashboard updates" fall out for free rather
 * than needing a refresh mechanism, and it's why nothing here holds a row of
 * the user's data.
 *
 * Persistence is IndexedDB in this phase; the same records are what Backend
 * Phase 2 will sync.
 */

export interface DashboardItem {
  spec: ChartSpec;
  /** react-grid-layout coordinates, in a 12-column grid. */
  layout: { x: number; y: number; w: number; h: number };
}

/**
 * A filter control on the dashboard's bar.
 *
 * The configured column and the current selection live together: a dashboard's
 * filter state is part of the dashboard, so reopening it shows the same slice
 * the user left it on.
 */
export interface DashboardFilterConfig {
  id: string;
  kind: 'date-range' | 'select';
  column: string;
  from?: string;
  to?: string;
  value?: string;
}

export interface Dashboard {
  id: string;
  name: string;
  items: DashboardItem[];
  filters: DashboardFilterConfig[];
  updatedAt: number;
}

export const DASHBOARD_COLUMNS = 12;
const DEFAULT_TILE = { w: 6, h: 6 };

interface DashboardState {
  dashboards: Dashboard[];
  activeId: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  create: (name?: string) => Promise<Dashboard>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  addChart: (dashboardId: string, spec: ChartSpec) => Promise<void>;
  removeChart: (dashboardId: string, chartId: string) => Promise<void>;
  updateChart: (dashboardId: string, spec: ChartSpec) => Promise<void>;
  setLayout: (dashboardId: string, layout: Record<string, DashboardItem['layout']>) => Promise<void>;
  setFilters: (dashboardId: string, filters: DashboardFilterConfig[]) => Promise<void>;
  /** Replace everything — used by workbench-file import. */
  replaceAll: (dashboards: Dashboard[]) => Promise<void>;
  clear: () => Promise<void>;
}

export const useDashboardStore = create<DashboardState>((set, get) => {
  async function persist(dashboard: Dashboard): Promise<void> {
    await idb.put('dashboards', dashboard);
  }

  function update(id: string, change: (dashboard: Dashboard) => Dashboard): Dashboard | null {
    const existing = get().dashboards.find((dashboard) => dashboard.id === id);
    if (!existing) return null;
    const updated = { ...change(existing), updatedAt: Date.now() };
    set((state) => ({
      dashboards: state.dashboards.map((dashboard) =>
        dashboard.id === id ? updated : dashboard,
      ),
    }));
    return updated;
  }

  return {
    dashboards: [],
    activeId: null,
    loaded: false,

    async load() {
      if (get().loaded) return;
      const dashboards = (await idb.getAll<Dashboard>('dashboards')).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      set({ dashboards, loaded: true, activeId: get().activeId ?? dashboards[0]?.id ?? null });
    },

    async create(name) {
      const dashboard: Dashboard = {
        id: newId('dash'),
        name: name ?? nextDashboardName(get().dashboards),
        items: [],
        filters: [],
        updatedAt: Date.now(),
      };
      track('dashboard.create');
      set((state) => ({ dashboards: [...state.dashboards, dashboard], activeId: dashboard.id }));
      await persist(dashboard);
      return dashboard;
    },

    async rename(id, name) {
      const updated = update(id, (dashboard) => ({ ...dashboard, name }));
      if (updated) await persist(updated);
    },

    async remove(id) {
      set((state) => {
        const dashboards = state.dashboards.filter((dashboard) => dashboard.id !== id);
        return {
          dashboards,
          activeId: state.activeId === id ? (dashboards[0]?.id ?? null) : state.activeId,
        };
      });
      await idb.remove('dashboards', id);
    },

    setActive(id) {
      set({ activeId: id });
    },

    async addChart(dashboardId, spec) {
      const updated = update(dashboardId, (dashboard) => ({
        ...dashboard,
        items: [
          ...dashboard.items,
          // New tiles go on a fresh row rather than hunting for a gap: a
          // predictable landing spot beats a clever one the user has to look for.
          { spec, layout: { x: 0, y: nextRow(dashboard.items), ...DEFAULT_TILE } },
        ],
      }));
      if (updated) await persist(updated);
    },

    async removeChart(dashboardId, chartId) {
      const updated = update(dashboardId, (dashboard) => ({
        ...dashboard,
        items: dashboard.items.filter((item) => item.spec.id !== chartId),
      }));
      if (updated) await persist(updated);
    },

    async updateChart(dashboardId, spec) {
      const updated = update(dashboardId, (dashboard) => ({
        ...dashboard,
        items: dashboard.items.map((item) => (item.spec.id === spec.id ? { ...item, spec } : item)),
      }));
      if (updated) await persist(updated);
    },

    async setLayout(dashboardId, layout) {
      const updated = update(dashboardId, (dashboard) => ({
        ...dashboard,
        items: dashboard.items.map((item) => ({
          ...item,
          layout: layout[item.spec.id] ?? item.layout,
        })),
      }));
      if (updated) await persist(updated);
    },

    async setFilters(dashboardId, filters) {
      const updated = update(dashboardId, (dashboard) => ({ ...dashboard, filters }));
      if (updated) await persist(updated);
    },

    async replaceAll(dashboards) {
      set({ dashboards, activeId: dashboards[0]?.id ?? null, loaded: true });
      await idb.clear('dashboards');
      await idb.putMany('dashboards', dashboards);
    },

    async clear() {
      set({ dashboards: [], activeId: null });
      await idb.clear('dashboards');
    },
  };
});

/** Turn the bar's configured controls into the filters the compiler applies. */
export function activeFilters(configs: DashboardFilterConfig[]): DashboardFilter[] {
  const filters: DashboardFilter[] = [];
  for (const config of configs) {
    if (!config.column) continue;
    if (config.kind === 'select' && config.value) {
      filters.push({ kind: 'equals', column: config.column, value: config.value });
    }
    // A half-filled date range would silently become an open-ended one, so both
    // ends are required before it applies.
    if (config.kind === 'date-range' && config.from && config.to) {
      filters.push({
        kind: 'date-range',
        column: config.column,
        from: config.from,
        to: config.to,
      });
    }
  }
  return filters;
}

function nextRow(items: DashboardItem[]): number {
  return items.reduce((bottom, item) => Math.max(bottom, item.layout.y + item.layout.h), 0);
}

export function nextDashboardName(dashboards: Dashboard[]): string {
  const taken = new Set(dashboards.map((dashboard) => dashboard.name));
  for (let n = 1; ; n++) {
    const candidate = `Dashboard ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
