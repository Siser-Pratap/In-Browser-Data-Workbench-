'use client';

import { useEffect, useMemo, useState } from 'react';
import { Filter, Plus, RotateCw, X } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { CONTROL_CLASS } from '@/components/ui/Field';
import { getEngine } from '@/lib/engine/engine';
import { quoteIdent } from '@/lib/engine/types';
import { cn } from '@/lib/utils/cn';
import type { DashboardFilterConfig } from '@/stores/dashboards';
import { useCatalogStore } from '@/stores/catalog';
import { newId } from '@/lib/utils/id';

interface Props {
  filters: DashboardFilterConfig[];
  onChange: (filters: DashboardFilterConfig[]) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

/**
 * The dashboard's filter bar.
 *
 * Filters name a *column*, not a table — every chart on the dashboard whose
 * query exposes that column gets the predicate injected, and the rest are left
 * alone (see `filtersFor`). That's what makes one control filter six charts
 * built on different queries without the user wiring anything up.
 *
 * Filtering is done in SQL, so a filtered dashboard costs another round of
 * queries rather than a client-side pass over data the browser is holding —
 * which is also why nothing is held.
 */
export function DashboardFilterBar({ filters, onChange, onRefresh, refreshing }: Props) {
  const catalog = useCatalogStore((state) => state.tables);

  // Every column in the workspace, de-duplicated by name — a dashboard's charts
  // may span several tables, and a filter is matched by name anyway.
  const columns = useMemo(() => {
    const byName = new Map<string, { name: string; kind: string }>();
    for (const table of catalog) {
      for (const column of table.columns) {
        if (!byName.has(column.name)) byName.set(column.name, column);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog]);

  const dateColumns = columns.filter((column) => column.kind === 'date');

  function update(id: string, patch: Partial<DashboardFilterConfig>) {
    onChange(filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)));
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5">
      <span className="flex items-center gap-1 text-[11px] text-[var(--color-ink-muted)]">
        <Filter className="size-3" /> Filters
      </span>

      {filters.map((filter) =>
        filter.kind === 'date-range' ? (
          <div key={filter.id} className="flex items-center gap-1">
            <select
              aria-label="Date column"
              value={filter.column}
              onChange={(event) => update(filter.id, { column: event.target.value })}
              className={cn(CONTROL_CLASS, 'w-auto py-0.5 text-[11px]')}
            >
              <option value="">date column…</option>
              {dateColumns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              aria-label="From"
              value={filter.from ?? ''}
              onChange={(event) => update(filter.id, { from: event.target.value })}
              className={cn(CONTROL_CLASS, 'w-auto py-0.5 text-[11px]')}
            />
            <span className="text-[11px] text-[var(--color-ink-muted)]">→</span>
            <input
              type="date"
              aria-label="To"
              value={filter.to ?? ''}
              onChange={(event) => update(filter.id, { to: event.target.value })}
              className={cn(CONTROL_CLASS, 'w-auto py-0.5 text-[11px]')}
            />
            <RemoveFilter filters={filters} id={filter.id} onChange={onChange} />
          </div>
        ) : (
          <div key={filter.id} className="flex items-center gap-1">
            <select
              aria-label="Filter column"
              value={filter.column}
              onChange={(event) => update(filter.id, { column: event.target.value, value: '' })}
              className={cn(CONTROL_CLASS, 'w-auto py-0.5 text-[11px]')}
            >
              <option value="">column…</option>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
            <ValuePicker
              column={filter.column}
              value={filter.value ?? ''}
              onChange={(value) => update(filter.id, { value })}
            />
            <RemoveFilter filters={filters} id={filter.id} onChange={onChange} />
          </div>
        ),
      )}

      <Button
        size="sm"
        icon={<Plus className="size-3" />}
        onClick={() =>
          onChange([...filters, { id: newId('f'), kind: 'select', column: '', value: '' }])
        }
      >
        Value
      </Button>
      <Button
        size="sm"
        icon={<Plus className="size-3" />}
        onClick={() =>
          onChange([
            ...filters,
            { id: newId('f'), kind: 'date-range', column: dateColumns[0]?.name ?? '' },
          ])
        }
      >
        Date range
      </Button>

      <Button
        size="sm"
        className="ml-auto"
        busy={refreshing}
        icon={<RotateCw className="size-3" />}
        onClick={onRefresh}
        title="Re-run every chart's query against the current tables"
      >
        Refresh
      </Button>
    </div>
  );
}

function RemoveFilter({
  filters,
  id,
  onChange,
}: {
  filters: DashboardFilterConfig[];
  id: string;
  onChange: (filters: DashboardFilterConfig[]) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Remove filter"
      onClick={() => onChange(filters.filter((filter) => filter.id !== id))}
      className="rounded p-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-danger)]"
    >
      <X className="size-3" />
    </button>
  );
}

/**
 * The distinct values of the chosen column.
 *
 * Loaded lazily and capped: a categorical filter over a high-cardinality column
 * would otherwise pull a million strings into a dropdown nobody can scroll.
 */
function ValuePicker({
  column,
  value,
  onChange,
}: {
  column: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [options, setOptions] = useState<{ column: string; values: string[] } | null>(null);

  useEffect(() => {
    if (!column) return;
    let cancelled = false;
    const catalog = useCatalogStore.getState().tables;
    const table = catalog.find((entry) =>
      entry.columns.some((candidate) => candidate.name === column),
    );
    if (!table) return;

    void getEngine()
      .runQuery(
        `SELECT DISTINCT ${quoteIdent(column)}::VARCHAR AS v FROM ${quoteIdent(table.name)} ` +
          `WHERE ${quoteIdent(column)} IS NOT NULL ORDER BY 1 LIMIT 200`,
      )
      .then((result) => {
        if (cancelled) return;
        setOptions({ column, values: result.rows.map((row) => String(row[0])) });
      })
      .catch(() => {
        if (!cancelled) setOptions({ column, values: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [column]);

  const values = options?.column === column ? options.values : [];

  return (
    <select
      aria-label="Filter value"
      value={value}
      disabled={!column}
      onChange={(event) => onChange(event.target.value)}
      className={cn(CONTROL_CLASS, 'w-auto py-0.5 text-[11px] disabled:opacity-40')}
    >
      <option value="">all</option>
      {values.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
