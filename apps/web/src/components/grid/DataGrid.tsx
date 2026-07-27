'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';

import { TypeIcon } from '@/components/grid/TypeIcon';
import { getEngine } from '@/lib/engine/engine';
import type { ColumnSchema, QueryResult } from '@/lib/engine/types';
import { cn } from '@/lib/utils/cn';
import { formatCount } from '@/lib/utils/format';

/** How many rows one fetch pulls back. */
const PAGE_SIZE = 1000;
const ROW_HEIGHT = 28;
const DEFAULT_COLUMN_WIDTH = 160;

interface Props {
  table: string;
  onStats?: (stats: { visibleRows: number; elapsedMs: number }) => void;
}

/**
 * Virtualised preview of a table.
 *
 * Two things keep this fast on tables of any size. Rows are fetched a page at a
 * time in SQL (`LIMIT`/`OFFSET`) so the full table is never in JS memory, and
 * only the visible slice is rendered, so the DOM stays small no matter how many
 * rows have been fetched. Sorting is pushed down to DuckDB for the same reason —
 * sorting a million rows in JS would freeze the tab.
 */
export function DataGrid({ table, onStats }: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  // A table change is a different dataset entirely; drop paging and sorting.
  useEffect(() => {
    setOffset(0);
    setSort(null);
    setResult(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [table]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await getEngine().preview(table, {
        limit: PAGE_SIZE,
        offset,
        orderBy: sort?.column,
        descending: sort?.descending,
      });
      setResult(page);
      onStats?.({ visibleRows: page.rowCount, elapsedMs: page.elapsedMs });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Query failed');
    } finally {
      setLoading(false);
    }
  }, [table, offset, sort, onStats]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = result?.columns ?? [];
  const rows = useMemo(() => result?.rows ?? [], [result]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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

  async function copyCell(value: unknown) {
    await navigator.clipboard.writeText(value === null ? '' : String(value));
    toast.success('Copied to clipboard');
  }

  if (!result && loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-ink-muted)]">
        <Loader2 className="size-4 animate-spin" /> Loading preview…
      </div>
    );
  }

  if (!result) return null;

  const totalWidth = columns.reduce(
    (sum, column) => sum + (widths[column.name] ?? DEFAULT_COLUMN_WIDTH),
    0,
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="relative flex-1 overflow-auto">
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          {/* Sticky header so column names survive a long scroll. */}
          <div className="sticky top-0 z-10 flex border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            {columns.map((column) => {
              const width = widths[column.name] ?? DEFAULT_COLUMN_WIDTH;
              const sorted = sort?.column === column.name;
              return (
                <div
                  key={column.name}
                  className="relative flex shrink-0 items-center gap-1 px-2 py-1.5 text-xs font-medium"
                  style={{ width }}
                >
                  <TypeIcon kind={column.kind} />
                  <button
                    type="button"
                    onClick={() => toggleSort(column)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-[var(--color-accent)]"
                    title={`${column.name} · ${column.type}`}
                  >
                    <span className="truncate">{column.name}</span>
                    {sorted &&
                      (sort.descending ? (
                        <ArrowDown className="size-3 shrink-0" />
                      ) : (
                        <ArrowUp className="size-3 shrink-0" />
                      ))}
                  </button>
                  <ColumnResizer
                    width={width}
                    onResize={(next) =>
                      setWidths((current) => ({ ...current, [column.name]: next }))
                    }
                  />
                </div>
              );
            })}
          </div>

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={virtualRow.key}
                  className="absolute top-0 left-0 flex w-full border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface)]"
                  style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                >
                  {columns.map((column, columnIndex) => {
                    const value = row[columnIndex];
                    return (
                      <button
                        type="button"
                        key={column.name}
                        onDoubleClick={() => void copyCell(value)}
                        title={value === null ? 'NULL' : String(value)}
                        className={cn(
                          'shrink-0 truncate px-2 py-1 text-left font-mono text-xs',
                          column.kind === 'number' && 'text-right',
                          value === null && 'text-[var(--color-ink-muted)] italic',
                        )}
                        style={{ width: widths[column.name] ?? DEFAULT_COLUMN_WIDTH }}
                      >
                        {value === null ? 'NULL' : String(value)}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <Pager
        offset={offset}
        pageRows={result.rowCount}
        loading={loading}
        onChange={(next) => {
          setOffset(next);
          scrollRef.current?.scrollTo({ top: 0 });
        }}
      />
    </div>
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
  if (!hasNext && !hasPrevious) return null;

  return (
    <div className="flex items-center justify-center gap-3 border-t border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)]">
      <button
        type="button"
        disabled={!hasPrevious || loading}
        onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        className="rounded px-2 py-0.5 enabled:hover:bg-[var(--color-surface)] disabled:opacity-40"
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
        className="rounded px-2 py-0.5 enabled:hover:bg-[var(--color-surface)] disabled:opacity-40"
      >
        Next
      </button>
      {loading && <Loader2 className="size-3 animate-spin" />}
    </div>
  );
}

/** Drag handle on a column's trailing edge. */
function ColumnResizer({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) {
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    function onMove(move: PointerEvent) {
      onResize(Math.max(60, startWidth + move.clientX - startX));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-[var(--color-accent)]"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
    />
  );
}
