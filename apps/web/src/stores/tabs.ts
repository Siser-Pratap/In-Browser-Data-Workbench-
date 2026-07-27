'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ChartSpec } from '@/lib/charts/spec';
import { getEngine } from '@/lib/engine/engine';
import type { QueryResult } from '@/lib/engine/types';
import { parseSqlError, type ParsedSqlError } from '@/lib/sql/errors';
import { track } from '@/lib/telemetry/telemetry';
import { newId } from '@/lib/utils/id';
import { useDatasetStore } from './datasets';
import { useHistoryStore } from './history';

/**
 * Query tabs.
 *
 * The split between `QueryTab` and `TabRuntime` is the important part: the tab
 * (its name and its SQL) is the user's work and is persisted, while the runtime
 * (result rows, error, timing) is derived and is not. Persisting a result would
 * mean writing potentially tens of thousands of rows of the user's data into
 * localStorage on every query — exactly the thing this product promises not to
 * do — and it would go stale the moment a table is re-imported. Re-running is
 * cheap; storing is not.
 */

export interface QueryTab {
  id: string;
  name: string;
  sql: string;
  /**
   * The chart built beside this tab's result, if any.
   *
   * Persisted with the tab, because a chart spec is authored work like the SQL
   * is — and it holds no data, only a query and an encoding, so storing it costs
   * a few hundred bytes and leaks nothing.
   */
  chart?: ChartSpec | null;
}

export type TabStatus = 'idle' | 'running' | 'done' | 'error';

export interface TabRuntime {
  status: TabStatus;
  result: QueryResult | null;
  error: ParsedSqlError | null;
  /**
   * The exact SQL that produced `result`.
   *
   * Not the same as the tab's current `sql`: the user may have run a selection,
   * or edited the buffer since. Export, "save as table" and charts all need the
   * query that actually made these rows, not whatever is in the editor now.
   */
  ranSql: string | null;
  /** True when the run was stopped by the user rather than finishing. */
  cancelled: boolean;
}

const IDLE: TabRuntime = {
  status: 'idle',
  result: null,
  error: null,
  ranSql: null,
  cancelled: false,
};

interface TabsState {
  tabs: QueryTab[];
  activeId: string | null;
  runtime: Record<string, TabRuntime>;

  openTab: (options?: { name?: string; sql?: string; run?: boolean }) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setSql: (id: string, sql: string) => void;
  setChart: (id: string, chart: ChartSpec | null) => void;
  renameTab: (id: string, name: string) => void;
  /** Run `sql` if given (a selection), otherwise the tab's whole buffer. */
  runTab: (id: string, sql?: string) => Promise<void>;
  cancelTab: (id: string) => Promise<void>;
  clearAll: () => void;
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      runtime: {},

      openTab({ name, sql = '', run = false } = {}) {
        const id = newId('tab');
        const tab: QueryTab = { id, name: name ?? nextTabName(get().tabs), sql };
        set((state) => ({
          tabs: [...state.tabs, tab],
          activeId: id,
          runtime: { ...state.runtime, [id]: IDLE },
        }));
        if (run && sql.trim()) void get().runTab(id);
        return id;
      },

      closeTab(id) {
        set((state) => {
          const index = state.tabs.findIndex((tab) => tab.id === id);
          const tabs = state.tabs.filter((tab) => tab.id !== id);
          const runtime = { ...state.runtime };
          delete runtime[id];
          return {
            tabs,
            runtime,
            // Focus the neighbour rather than jumping to the first tab: closing
            // the third of five should land on what was next to it.
            activeId:
              state.activeId === id
                ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
                : state.activeId,
          };
        });
      },

      setActive(id) {
        set({ activeId: id });
      },

      setSql(id, sql) {
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab)),
        }));
      },

      setChart(id, chart) {
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, chart } : tab)),
        }));
      },

      renameTab(id, name) {
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, name } : tab)),
        }));
      },

      async runTab(id, sql) {
        const tab = get().tabs.find((item) => item.id === id);
        if (!tab) return;
        const statement = (sql ?? tab.sql).trim();
        if (!statement) return;

        patchRuntime(set, id, { status: 'running', error: null, cancelled: false });
        const started = performance.now();

        try {
          // A cancelled query still resolves — with the batches that arrived
          // before DuckDB stopped. `cancelled` is left set by `cancelTab` so the
          // grid can label those rows as partial rather than passing them off as
          // the whole answer.
          const result = await getEngine().runQuery(statement);
          patchRuntime(set, id, {
            status: 'done',
            result,
            error: null,
            ranSql: statement,
          });
          track('query.run');
          void useHistoryStore.getState().record({
            sql: statement,
            durationMs: Math.round(performance.now() - started),
            rowCount: result.rowCount,
            ok: true,
            tables: tableNames(),
          });
        } catch (error) {
          patchRuntime(set, id, {
            status: 'error',
            error: parseSqlError(error),
            result: null,
            ranSql: statement,
          });
          track('query.fail');
          void useHistoryStore.getState().record({
            sql: statement,
            durationMs: Math.round(performance.now() - started),
            rowCount: null,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            tables: tableNames(),
          });
        }
      },

      async cancelTab(id) {
        // Mark first: `runQuery` resolves with the partial result once DuckDB
        // stops, and the UI should be able to say those rows are incomplete.
        track('query.cancel');
        patchRuntime(set, id, { cancelled: true });
        await getEngine().cancel();
      },

      clearAll() {
        set({ tabs: [], activeId: null, runtime: {} });
      },
    }),
    {
      name: 'workbench-tabs',
      // Only the SQL the user wrote. Results — which are their data — are never
      // written to disk by this store.
      partialize: (state) => ({
        tabs: state.tabs,
        activeId: state.activeId,
      }),
      onRehydrateStorage: () => (state) => {
        // Restored tabs have no runtime; give each one a clean idle slot so the
        // UI never has to guard against a missing entry.
        if (!state) return;
        state.runtime = Object.fromEntries(state.tabs.map((tab) => [tab.id, IDLE]));
      },
    },
  ),
);

function patchRuntime(
  set: (partial: (state: TabsState) => Partial<TabsState>) => void,
  id: string,
  patch: Partial<TabRuntime>,
): void {
  set((state) => ({
    runtime: { ...state.runtime, [id]: { ...(state.runtime[id] ?? IDLE), ...patch } },
  }));
}

function tableNames(): string[] {
  return useDatasetStore.getState().datasets.map((dataset) => dataset.table);
}

/** "Query 1", "Query 2", … skipping names already taken. */
export function nextTabName(tabs: QueryTab[]): string {
  const taken = new Set(tabs.map((tab) => tab.name));
  for (let n = 1; ; n++) {
    const candidate = `Query ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The runtime for a tab, never undefined. */
export function runtimeFor(state: TabsState, id: string | null): TabRuntime {
  return (id && state.runtime[id]) || IDLE;
}
