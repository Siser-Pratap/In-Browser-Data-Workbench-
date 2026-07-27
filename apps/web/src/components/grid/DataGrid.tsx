'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { ResultsGrid, type SortState } from '@/components/grid/ResultsGrid';
import { getEngine } from '@/lib/engine/engine';
import type { ColumnSchema, QueryResult } from '@/lib/engine/types';
import { formatCount } from '@/lib/utils/format';

/** How many rows one fetch pulls back. */
const PAGE_SIZE = 1000;

interface Props {
  table: string;
  onStats?: (stats: { visibleRows: number; elapsedMs: number }) => void;
}

/**
 * Paged preview of a table.
 *
 * The paging and sorting live here; the rendering is `ResultsGrid`'s job. What
 * makes this fast on a table of any size is that neither concern is done in JS:
 * a page is a `LIMIT`/`OFFSET` query and a sort is an `ORDER BY`, so the full
 * table is never in memory and sorting a million rows never blocks the tab.
 *
 * Callers key this on the table name so switching datasets remounts it — paging
 * and sort state belong to the table being viewed, and carrying "page 40, sorted
 * by revenue" over to a different file would be nonsense.
 */
export function DataGrid({ table, onStats }: Props) {
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortState | null>(null);
  // The page is stored alongside the request that produced it. "Loading" is then
  // derived — `page.key !== key` — rather than being a flag someone has to
  // remember to clear, and a stale page can never be shown under a new sort.
  const [page, setPage] = useState<{ key: string; result: QueryResult } | null>(null);

  const onStatsRef = useRef(onStats);
  useEffect(() => {
    onStatsRef.current = onStats;
  });

  const key = `${table}|${offset}|${sort?.column ?? ''}|${sort?.descending ?? ''}`;
  // The last page stays on screen while the next one loads, with the spinner in
  // the footer saying so. Blanking the grid on every Next click would make
  // paging feel far slower than the ~10 ms the query actually takes.
  const result = page?.result ?? null;
  const loading = page?.key !== key;

  useEffect(() => {
    // Guarded against out-of-order responses: paging quickly can leave two
    // previews in flight, and a slow earlier one landing last would otherwise
    // store a page under a key nobody is asking for — leaving the grid stuck on
    // its spinner with no pending request to rescue it.
    let cancelled = false;

    void (async () => {
      try {
        const fetched = await getEngine().preview(table, {
          limit: PAGE_SIZE,
          offset,
          orderBy: sort?.column,
          descending: sort?.descending,
        });
        if (cancelled) return;
        setPage({ key, result: fetched });
        onStatsRef.current?.({ visibleRows: fetched.rowCount, elapsedMs: fetched.elapsedMs });
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Query failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [table, offset, sort, key]);

  function toggleSort(column: ColumnSchema) {
    setOffset(0);
    setSort((current) =>
      current?.column === column.name
        ? current.descending
          ? null // third click clears the sort
          : { column: column.name, descending: true }
        : { column: column.name, descending: false },
    );
  }

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-ink-muted)]">
        <Loader2 className="size-4 animate-spin" /> Loading preview…
      </div>
    );
  }

  return (
    <ResultsGrid
      result={result}
      sort={sort}
      onSort={toggleSort}
      loading={loading}
      rowOffset={offset}
      footer={
        <Pager
          offset={offset}
          pageRows={result.rowCount}
          loading={loading}
          onChange={setOffset}
        />
      }
    />
  );
}

function Pager({
  offset,
  pageRows,
  loading,
  onChange,
}: {
  offset: number;
  pageRows: number;
  loading: boolean;
  onChange: (offset: number) => void;
}) {
  // A full page implies there may be more; a short page means this is the end.
  const hasNext = pageRows === PAGE_SIZE;
  const hasPrevious = offset > 0;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={!hasPrevious || loading}
        onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        className="rounded px-1.5 py-0.5 enabled:hover:bg-[var(--color-surface-raised)] disabled:opacity-40"
      >
        Previous
      </button>
      <span>
        rows {formatCount(offset + 1)}–{formatCount(offset + pageRows)}
      </span>
      <button
        type="button"
        disabled={!hasNext || loading}
        onClick={() => onChange(offset + PAGE_SIZE)}
        className="rounded px-1.5 py-0.5 enabled:hover:bg-[var(--color-surface-raised)] disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}
