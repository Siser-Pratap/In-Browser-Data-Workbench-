'use client';

import { create } from 'zustand';

import { ApiError } from '@/lib/api/problem';
import { fromSnapshot, toSnapshot, type LocalWorkspace } from '@/lib/api/snapshot';
import type { SnapshotIn, Workspace } from '@/lib/api/types';
import {
  createWorkspace,
  deleteWorkspace,
  getSnapshot,
  listWorkspaces,
  saveSnapshot,
} from '@/lib/api/workspaces';
import { track } from '@/lib/telemetry/telemetry';
import { useDashboardStore } from '@/stores/dashboards';
import { useDatasetStore } from '@/stores/datasets';
import { useHistoryStore } from '@/stores/history';
import { useTabsStore } from '@/stores/tabs';

/**
 * Cloud workspaces: the list, which one is open, and the save/load round trip.
 *
 * Sync is explicit. There is no autosave and no background push, because a
 * local-first tool that silently uploads is exactly the thing this product
 * tells people it isn't — and because "last write wins" is only defensible when
 * the user knows they performed the write.
 *
 * The `etag` is the whole concurrency story. It comes back from every read and
 * every write and is replayed as `If-Match` on the next save; a server that has
 * moved on answers 409, which surfaces here as `conflict` for the UI to resolve
 * rather than being retried or swallowed.
 */

export type CloudStatus = 'idle' | 'listing' | 'saving' | 'loading';

/** A save the server rejected as stale, held so the user can choose. */
export interface Conflict {
  snapshot: SnapshotIn;
  workspaceId: string;
}

interface CloudState {
  workspaces: Workspace[];
  activeId: string | null;
  etag: string | null;
  status: CloudStatus;
  lastSavedAt: number | null;
  conflict: Conflict | null;

  refresh: () => Promise<void>;
  create: (name: string) => Promise<Workspace>;
  save: () => Promise<void>;
  open: (workspaceId: string) => Promise<void>;
  remove: (workspaceId: string) => Promise<void>;
  /** Resolve a 409: re-save over the server's version, or discard and reload. */
  resolveConflict: (choice: 'overwrite' | 'reload') => Promise<void>;
  /** Forget cloud state without touching local work (used on sign-out). */
  reset: () => void;
}

/** Collect the current local workspace from the stores that own each part. */
export function collectLocal(): LocalWorkspace {
  return {
    datasets: useDatasetStore.getState().datasets.map((dataset) => ({
      table: dataset.table,
      sourceFilename: dataset.sourceFilename,
      format: dataset.format,
      columns: dataset.columns,
      rowCount: dataset.rowCount,
    })),
    queries: useTabsStore.getState().tabs,
    snippets: useHistoryStore.getState().snippets,
    dashboards: useDashboardStore.getState().dashboards,
  };
}

/**
 * Replace local work with a pulled snapshot.
 *
 * Tabs and dashboards are replaced outright; snippets are merged by name, the
 * same rule the `.dwb.json` import uses. Datasets are deliberately untouched —
 * the snapshot carries only their metadata, and the actual tables live in this
 * browser's engine. Dropping them because the server didn't send rows would
 * destroy the user's loaded data to satisfy a sync.
 */
async function applyLocal(local: LocalWorkspace): Promise<void> {
  const tabs = useTabsStore.getState();
  tabs.clearAll();
  for (const query of local.queries) {
    const id = tabs.openTab({ name: query.name, sql: query.sql });
    if (query.chart) useTabsStore.getState().setChart(id, query.chart);
  }

  await useDashboardStore.getState().replaceAll(local.dashboards);

  const history = useHistoryStore.getState();
  const existing = new Set(history.snippets.map((snippet) => snippet.name));
  for (const snippet of local.snippets) {
    if (!existing.has(snippet.name)) await history.addSnippet(snippet.name, snippet.sql);
  }
}

export const useCloudStore = create<CloudState>()((set, get) => ({
  workspaces: [],
  activeId: null,
  etag: null,
  status: 'idle',
  lastSavedAt: null,
  conflict: null,

  refresh: async () => {
    set({ status: 'listing' });
    try {
      const list = await listWorkspaces();
      set({ workspaces: list.items });
    } finally {
      set({ status: 'idle' });
    }
  },

  create: async (name) => {
    const workspace = await createWorkspace(name);
    set((state) => ({
      workspaces: [workspace, ...state.workspaces],
      activeId: workspace.id,
      // A brand-new workspace has nothing to be stale against.
      etag: null,
    }));
    track('workspace.cloud_create');
    return workspace;
  },

  save: async () => {
    const { activeId, etag } = get();
    if (!activeId) throw new Error('No cloud workspace is open.');

    const snapshot = toSnapshot(collectLocal());
    set({ status: 'saving' });
    try {
      const result = await saveSnapshot(activeId, snapshot, etag);
      set({ etag: result.etag, lastSavedAt: Date.now(), conflict: null });
      track('workspace.cloud_save');
    } catch (error) {
      if (error instanceof ApiError && error.isConflict) {
        set({ conflict: { snapshot, workspaceId: activeId } });
      }
      throw error;
    } finally {
      set({ status: 'idle' });
    }
  },

  open: async (workspaceId) => {
    set({ status: 'loading' });
    try {
      const { snapshot, etag } = await getSnapshot(workspaceId);
      await applyLocal(fromSnapshot(snapshot));
      set({ activeId: workspaceId, etag, conflict: null });
      track('workspace.cloud_open');
    } finally {
      set({ status: 'idle' });
    }
  },

  remove: async (workspaceId) => {
    await deleteWorkspace(workspaceId);
    set((state) => ({
      workspaces: state.workspaces.filter((workspace) => workspace.id !== workspaceId),
      ...(state.activeId === workspaceId ? { activeId: null, etag: null } : {}),
    }));
  },

  resolveConflict: async (choice) => {
    const conflict = get().conflict;
    if (!conflict) return;

    if (choice === 'reload') {
      set({ conflict: null });
      await get().open(conflict.workspaceId);
      return;
    }

    // Overwrite: re-read to learn the server's current version, then save with
    // it. Sending no If-Match at all would work too, but re-reading keeps the
    // etag we hold correct for the *next* save rather than leaving it null.
    set({ status: 'saving' });
    try {
      const { etag } = await getSnapshot(conflict.workspaceId);
      const result = await saveSnapshot(conflict.workspaceId, conflict.snapshot, etag);
      set({ etag: result.etag, lastSavedAt: Date.now(), conflict: null });
    } finally {
      set({ status: 'idle' });
    }
  },

  reset: () =>
    set({
      workspaces: [],
      activeId: null,
      etag: null,
      lastSavedAt: null,
      conflict: null,
      status: 'idle',
    }),
}));
