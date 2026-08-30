/**
 * Translating between the local workbench and the server's snapshot document.
 *
 * The payload is deliberately the same shape as the `.dwb.json` export: dataset
 * *metadata*, queries, chart specs and dashboards, and **no rows**. That is not
 * a convenience — it's the reason cloud sync doesn't weaken the privacy claim.
 * Saving to the cloud uploads what you authored, never what you loaded.
 *
 * Two asymmetries are worth knowing before changing anything here:
 *
 * 1. **A save is a complete replacement.** The server deletes any row the
 *    snapshot omits (`workspace_service.save_snapshot`), so `toSnapshot` must
 *    always describe the whole workspace, never a delta.
 *
 * 2. **Ids are one-directional.** Local ids are prefixed (`tab_…`), so the
 *    server can't parse them as UUIDs and mints its own. It does key its
 *    chart→query link map by the raw client string, which is why `query_id`
 *    below is the local tab id and resolves correctly anyway. Coming back the
 *    other way we mint fresh local ids rather than trying to reuse the server's.
 *
 * Snippets have no first-class resource on the server, so they ride in the
 * workspace's free-form `settings`. They're a handful of short strings; giving
 * them a table to round-trip cleanly would be more machinery than they're worth.
 */

import type { ChartSpec } from '@/lib/charts/spec';
import type { ColumnSchema, SupportedFormat } from '@/lib/engine/types';
import type { WorkbenchDatasetRef } from '@/lib/export/workbench';
import type { Dashboard, DashboardFilterConfig, DashboardItem } from '@/stores/dashboards';
import type { Snippet } from '@/stores/history';
import type { QueryTab } from '@/stores/tabs';
import { newId } from '@/lib/utils/id';

import type { SnapshotIn, SnapshotResponse } from './types';

/** Bumped if the settings blob's shape ever changes incompatibly. */
export const SNAPSHOT_SETTINGS_VERSION = 1;

/**
 * The version stamped on a dashboard's `layout`.
 *
 * The server treats `spec` and `layout` as opaque so chart and layout formats
 * can change without a backend migration, but it *does* require the envelope to
 * declare a version (`schemas/workspace.py::_validate_envelope`) — a body
 * without one is rejected with 422. Chart specs already carry `version`
 * themselves; a dashboard layout is assembled here, so the stamp is applied
 * here too.
 */
export const DASHBOARD_LAYOUT_VERSION = 1;

export interface LocalWorkspace {
  datasets: WorkbenchDatasetRef[];
  queries: QueryTab[];
  snippets: Snippet[];
  dashboards: Dashboard[];
}

export function toSnapshot(local: LocalWorkspace, name?: string): SnapshotIn {
  return {
    ...(name ? { name } : {}),
    settings: {
      workbench_version: SNAPSHOT_SETTINGS_VERSION,
      snippets: local.snippets,
    },

    datasets: local.datasets.map((dataset) => ({
      name: dataset.table,
      source_filename: dataset.sourceFilename,
      format: dataset.format,
      // The column list, not the data. `schema` is free-form on the server.
      schema: { columns: dataset.columns },
      row_count: dataset.rowCount,
    })),

    queries: local.queries.map((tab, position) => ({
      id: tab.id,
      name: tab.name,
      sql: tab.sql,
      position,
    })),

    // Only tabs that actually have a chart. `query_id` is the local tab id: the
    // server maps it to the row it just wrote for that query.
    charts: local.queries
      .filter((tab): tab is QueryTab & { chart: ChartSpec } => Boolean(tab.chart))
      .map((tab) => ({ query_id: tab.id, spec: tab.chart as unknown as Record<string, unknown> })),

    dashboards: local.dashboards.map((dashboard) => ({
      name: dashboard.name,
      // The tiles and their filters travel together in the opaque `layout` —
      // splitting them would need a second resource for no gain. `version` is
      // the envelope stamp the server insists on; without it this is a 422.
      layout: {
        version: DASHBOARD_LAYOUT_VERSION,
        items: dashboard.items,
        filters: dashboard.filters,
        updatedAt: dashboard.updatedAt,
      } as unknown as Record<string, unknown>,
    })),
  };
}

/**
 * Rebuild local state from a snapshot.
 *
 * Defensive about missing and malformed fields throughout: this document may
 * have been written by a different version of the app, or by a workspace that
 * was shared rather than authored here.
 */
export function fromSnapshot(snapshot: SnapshotResponse): LocalWorkspace {
  const chartsByQuery = new Map<string, ChartSpec>();
  for (const chart of snapshot.charts ?? []) {
    if (chart.query_id && chart.spec) {
      chartsByQuery.set(chart.query_id, chart.spec as unknown as ChartSpec);
    }
  }

  const queries: QueryTab[] = [...(snapshot.queries ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((query) => ({
      id: newId('tab'),
      name: query.name,
      sql: query.sql,
      chart: chartsByQuery.get(query.id) ?? null,
    }));

  const datasets: WorkbenchDatasetRef[] = (snapshot.datasets ?? []).map((dataset) => ({
    table: dataset.name,
    sourceFilename: dataset.source_filename ?? '',
    format: (dataset.format ?? 'csv') as SupportedFormat,
    columns: readColumns(dataset.schema),
    rowCount: dataset.row_count ?? 0,
  }));

  const dashboards: Dashboard[] = (snapshot.dashboards ?? []).map((dashboard) => {
    const layout = asRecord(dashboard.layout);
    return {
      id: newId('dash'),
      name: dashboard.name,
      items: asArray<DashboardItem>(layout['items']),
      filters: asArray<DashboardFilterConfig>(layout['filters']),
      updatedAt: typeof layout['updatedAt'] === 'number' ? layout['updatedAt'] : Date.now(),
    };
  });

  return {
    datasets,
    queries,
    snippets: readSnippets(snapshot.workspace?.settings),
    dashboards,
  };
}

function readSnippets(settings: unknown): Snippet[] {
  const record = asRecord(settings);
  return asArray<Snippet>(record['snippets']).filter(
    (snippet) => typeof snippet?.name === 'string' && typeof snippet?.sql === 'string',
  );
}

function readColumns(schema: unknown): ColumnSchema[] {
  const record = asRecord(schema);
  return asArray<ColumnSchema>(record['columns']).filter(
    (column) => typeof column?.name === 'string',
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
