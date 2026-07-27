'use client';

import { useEffect, useState } from 'react';

import { compileChart, type DashboardFilter } from '@/lib/charts/compile';
import type { ChartSpec } from '@/lib/charts/spec';
import { getEngine } from '@/lib/engine/engine';
import type { QueryResult } from '@/lib/engine/types';
import { parseSqlError } from '@/lib/sql/errors';
import { useCatalogStore } from '@/stores/catalog';

export interface ChartData {
  sql: string | null;
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
}

/**
 * Compile a chart spec to SQL, run it, and keep the answer in step with the spec.
 *
 * The outcome is stored tagged with the SQL that produced it, so "is this
 * loading?" is derived rather than tracked — the same pattern as the data grid.
 * That matters more here than usual: dashboards re-run every chart at once when
 * a filter changes, and a lingering loading flag or a late response landing over
 * a newer one would show numbers that don't match the filter bar.
 */
export function useChartData(spec: ChartSpec, filters: DashboardFilter[] = []): ChartData {
  const [outcome, setOutcome] = useState<{
    sql: string;
    result: QueryResult | null;
    error: string | null;
  } | null>(null);

  /**
   * The catalogue is a dependency, not just context.
   *
   * A chart's SQL names tables, and those tables come and go: a reload restores
   * them from OPFS *after* the page mounts, and re-importing a file replaces
   * one. Re-running when the catalogue changes is what makes a dashboard opened
   * on a cold page eventually show its data instead of a permanent "table does
   * not exist", and it's also the plan's dashboard auto-refresh — the query
   * simply runs again against whatever the engine now holds.
   */
  const catalog = useCatalogStore((state) => state.tables);

  let sql: string | null = null;
  let compileError: string | null = null;
  try {
    sql = compileChart(spec, filters);
  } catch (error) {
    compileError = error instanceof Error ? error.message : 'This chart is not configured yet.';
  }

  useEffect(() => {
    if (!sql) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = await getEngine().runQuery(sql);
        if (!cancelled) setOutcome({ sql, result, error: null });
      } catch (error) {
        if (!cancelled) {
          const parsed = parseSqlError(error);
          setOutcome({ sql, result: null, error: `${parsed.title}: ${parsed.detail}` });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sql, catalog]);

  if (compileError) return { sql: null, result: null, error: compileError, loading: false };

  const current = outcome?.sql === sql ? outcome : null;
  return {
    sql,
    result: current?.result ?? null,
    error: current?.error ?? null,
    loading: current === null,
  };
}
