import { describe, expect, it } from 'vitest';

import type { SnapshotResponse } from './types';
import { fromSnapshot, toSnapshot, type LocalWorkspace } from './snapshot';

const local: LocalWorkspace = {
  datasets: [
    {
      table: 'sales',
      sourceFilename: 'sales.csv',
      format: 'csv',
      columns: [{ name: 'region', type: 'VARCHAR', kind: 'string' }],
      rowCount: 42,
    },
  ],
  queries: [
    { id: 'tab_1', name: 'By region', sql: 'SELECT * FROM sales', chart: null },
    {
      id: 'tab_2',
      name: 'Charted',
      sql: 'SELECT region, count(*) FROM sales GROUP BY 1',
      chart: { id: 'chart_1', type: 'bar', query: 'SELECT 1' } as never,
    },
  ],
  snippets: [{ id: 's_1', name: 'Handy', sql: 'SELECT 1', createdAt: 1 }],
  dashboards: [{ id: 'dash_1', name: 'Overview', items: [], filters: [], updatedAt: 7 }],
};

describe('toSnapshot', () => {
  it('carries metadata and never rows', () => {
    const snapshot = toSnapshot(local);
    const serialised = JSON.stringify(snapshot);

    expect(snapshot.datasets?.[0]?.name).toBe('sales');
    expect(snapshot.datasets?.[0]?.row_count).toBe(42);
    // The product's central promise, asserted rather than assumed: the payload
    // describes the shape of the data and contains none of it.
    expect(serialised).not.toContain('rows');
    expect(snapshot.datasets?.[0]).not.toHaveProperty('data');
  });

  it('positions queries by their order', () => {
    const snapshot = toSnapshot(local);
    expect(snapshot.queries?.map((query) => [query.name, query.position])).toEqual([
      ['By region', 0],
      ['Charted', 1],
    ]);
  });

  it('emits a chart only for tabs that have one, linked by the local tab id', () => {
    const snapshot = toSnapshot(local);
    expect(snapshot.charts).toHaveLength(1);
    // The server keys its chart->query map by this raw string, which is what
    // makes prefixed local ids work despite not being UUIDs.
    expect(snapshot.charts?.[0]?.query_id).toBe('tab_2');
  });

  it('stamps a version on the dashboard layout envelope', () => {
    // The server rejects a `layout` or `spec` without `version` (422), but the
    // rule lives in a Pydantic field_validator that OpenAPI cannot express — so
    // the generated types happily accept a body the API refuses. This is the
    // only place that requirement is checked on the client side.
    const snapshot = toSnapshot(local);
    expect(snapshot.dashboards?.[0]?.layout).toHaveProperty('version');
  });

  it('sends chart specs that already carry their own version', () => {
    const snapshot = toSnapshot({
      ...local,
      queries: [
        {
          id: 'tab_1',
          name: 'Charted',
          sql: 'SELECT 1',
          chart: { version: 1, id: 'c', type: 'bar', query: 'SELECT 1' } as never,
        },
      ],
    });
    expect(snapshot.charts?.[0]?.spec).toHaveProperty('version', 1);
  });

  it('puts snippets in settings, since the server has no snippet resource', () => {
    const snapshot = toSnapshot(local);
    expect(snapshot.settings?.['snippets']).toEqual(local.snippets);
  });

  it('includes the name only when one is given', () => {
    expect(toSnapshot(local).name).toBeUndefined();
    expect(toSnapshot(local, 'Mine').name).toBe('Mine');
  });
});

function response(overrides: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return {
    workspace: {
      id: 'w1',
      owner_id: 'u1',
      name: 'Remote',
      description: null,
      is_public: false,
      settings: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    datasets: [],
    queries: [],
    charts: [],
    dashboards: [],
    version: 'v1',
    ...overrides,
  } as SnapshotResponse;
}

describe('fromSnapshot', () => {
  it('orders queries by position, not by array order', () => {
    const local = fromSnapshot(
      response({
        queries: [
          { id: 'b', name: 'second', sql: 'SELECT 2', position: 1 },
          { id: 'a', name: 'first', sql: 'SELECT 1', position: 0 },
        ] as never,
      }),
    );
    expect(local.queries.map((query) => query.name)).toEqual(['first', 'second']);
  });

  it('reattaches each chart to its query', () => {
    const local = fromSnapshot(
      response({
        queries: [{ id: 'q1', name: 'one', sql: 'SELECT 1', position: 0 }] as never,
        charts: [{ id: 'c1', query_id: 'q1', spec: { type: 'bar' } }] as never,
      }),
    );
    expect(local.queries[0]?.chart).toEqual({ type: 'bar' });
  });

  it("mints fresh local ids rather than reusing the server's", () => {
    const local = fromSnapshot(
      response({ queries: [{ id: 'q1', name: 'one', sql: 'SELECT 1', position: 0 }] as never }),
    );
    expect(local.queries[0]?.id).not.toBe('q1');
    expect(local.queries[0]?.id).toMatch(/^tab_/);
  });

  it('reads snippets back out of settings', () => {
    const local = fromSnapshot(
      response({
        workspace: {
          ...response().workspace,
          settings: { snippets: [{ id: 's_1', name: 'Handy', sql: 'SELECT 1', createdAt: 1 }] },
        },
      }),
    );
    expect(local.snippets).toHaveLength(1);
    expect(local.snippets[0]?.name).toBe('Handy');
  });

  it('drops snippets that are missing a name or sql', () => {
    const local = fromSnapshot(
      response({
        workspace: {
          ...response().workspace,
          settings: { snippets: [{ id: 's_1' }, { name: 'ok', sql: 'SELECT 1' }] },
        },
      }),
    );
    expect(local.snippets).toHaveLength(1);
  });

  it('survives absent, null and wrongly-typed fields', () => {
    // This document may come from a different app version or a shared
    // workspace, so nothing in it can be assumed well-formed.
    const local = fromSnapshot(
      response({
        datasets: [{ id: 'd1', name: 'partial', storage_mode: 'local' }] as never,
        dashboards: [{ id: 'x', name: 'No layout' }] as never,
        workspace: { ...response().workspace, settings: { snippets: 'not an array' } },
      }),
    );
    expect(local.datasets[0]?.columns).toEqual([]);
    expect(local.datasets[0]?.rowCount).toBe(0);
    expect(local.dashboards[0]?.items).toEqual([]);
    expect(local.snippets).toEqual([]);
  });
});

describe('round trip', () => {
  it('preserves the authored work through a save and a load', () => {
    const snapshot = toSnapshot(local);
    // Mirror what the server sends back: its own ids, same content.
    const restored = fromSnapshot(
      response({
        workspace: { ...response().workspace, settings: snapshot.settings as never },
        datasets: snapshot.datasets?.map((dataset, index) => ({
          ...dataset,
          id: `d${index}`,
          storage_mode: 'local',
        })) as never,
        queries: snapshot.queries?.map((query) => ({ ...query, id: query.id })) as never,
        charts: snapshot.charts?.map((chart, index) => ({ ...chart, id: `c${index}` })) as never,
        dashboards: snapshot.dashboards?.map((dashboard, index) => ({
          ...dashboard,
          id: `b${index}`,
        })) as never,
      }),
    );

    expect(restored.queries.map((query) => query.sql)).toEqual(
      local.queries.map((query) => query.sql),
    );
    expect(restored.datasets.map((dataset) => dataset.table)).toEqual(['sales']);
    expect(restored.snippets.map((snippet) => snippet.name)).toEqual(['Handy']);
    expect(restored.dashboards.map((dashboard) => dashboard.name)).toEqual(['Overview']);
    expect(restored.queries[1]?.chart).toBeTruthy();
  });
});
