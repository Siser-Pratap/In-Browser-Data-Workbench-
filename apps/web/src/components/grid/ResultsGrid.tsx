'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';

import { TypeIcon } from '@/components/grid/TypeIcon';
import type { ColumnSchema, QueryResult } from '@/lib/engine/types';
import { toCsv, toMarkdown } from '@/lib/export/serialize';
import { cn } from '@/lib/utils/cn';
import { formatCount } from '@/lib/utils/format';

const ROW_HEIGHT = 28;
const DEFAULT_COLUMN_WIDTH = 160;
const GUTTER_WIDTH = 56;

export interface SortState {
  column: string;
  descending: boolean;
}

interface Props {
  result: QueryResult;
  /** Omit to make headers unsortable (a query result already has its ORDER BY). */
  sort?: SortState | null;
  onSort?: (column: ColumnSchema) => void;
  loading?: boolean;
  /** Index of the first row within the whole result, for the row numbers. */
  rowOffset?: number;
  /** Rendered at the left of the footer bar. */
  footer?: React.ReactNode;
}

interface CellRange {
  anchorRow: number;
  anchorColumn: number;
  focusRow: number;
  focusColumn: number;
}

/**
 * The result grid.
 *
 * Presentational on purpose: it takes a `QueryResult` and knows nothing about
 * where the rows came from. That's what lets the same component serve the table
 * preview (which pages through a table) and every query tab (which shows one
 * materialised result) without either growing a special case.
 *
 * Rendering is virtualised over rows, so the DOM stays at a screenful no matter
 * how many rows the result holds.
 */
export function ResultsGrid({ result, sort, onSort, loading, rowOffset = 0, footer }: Props) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  // The selection is tagged with the result it was made in: a new result is a
  // different shape entirely, and cells selected in the old one may not exist.
  // Deriving that beats clearing it in an effect, which would leave one render
  // where the stale rectangle is still painted.
  const [selection, setSelection] = useState<{ of: QueryResult; range: CellRange } | null>(null);
  const dragging = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const { columns, rows } = result;
  const range = selection?.of === result ? selection.range : null;

  const setRange = useCallback(
    (next: CellRange | null | ((current: CellRange | null) => CellRange | null)) => {
      setSelection((previous) => {
        const currentRange = previous?.of === result ? previous.range : null;
        const value = typeof next === 'function' ? next(currentRange) : next;
        return value ? { of: result, range: value } : null;
      });
    },
    [result],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [result]);

  // React Compiler declines to memoize any component using `useVirtualizer`,
  // because the virtualizer's methods read mutable internal state and caching
  // their results would show stale rows. That's the correct call, and this
  // component doesn't need the memoization: it re-renders on scroll by design,
  // and the expensive work (the SQL) happens elsewhere. Silenced so the warning
  // doesn't train anyone to skim past lint output.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const bounds = useMemo(() => normalize(range), [range]);

  const selectedRows = useMemo(() => {
    if (!bounds) return [];
    return rows
      .slice(bounds.top, bounds.bottom + 1)
      .map((row) => row.slice(bounds.left, bounds.right + 1));
  }, [bounds, rows]);

  const selectedColumns = useMemo(
    () => (bounds ? columns.slice(bounds.left, bounds.right + 1) : []),
    [bounds, columns],
  );

  const copySelection = useCallback(
    async (format: 'csv' | 'markdown') => {
      // With nothing selected, "copy" means the visible result — the common
      // case is wanting the whole thing, and forcing a select-all first is
      // friction with no upside.
      const targetColumns = selectedColumns.length > 0 ? selectedColumns : columns;
      const targetRows = selectedRows.length > 0 ? selectedRows : rows;
      const text =
        format === 'csv' ? toCsv(targetColumns, targetRows) : toMarkdown(targetColumns, targetRows);
      try {
        await navigator.clipboard.writeText(text);
        toast.success(
          `Copied ${formatCount(targetRows.length)} row(s) as ${format === 'csv' ? 'CSV' : 'Markdown'}`,
        );
      } catch {
        toast.error('The browser blocked clipboard access');
      }
    },
    [columns, rows, selectedColumns, selectedRows],
  );

  function selectCell(rowIndex: number, columnIndex: number, extend: boolean) {
    setRange((current) =>
      extend && current
        ? { ...current, focusRow: rowIndex, focusColumn: columnIndex }
        : {
            anchorRow: rowIndex,
            anchorColumn: columnIndex,
            focusRow: rowIndex,
            focusColumn: columnIndex,
          },
    );
  }

  function selectWholeColumn(columnIndex: number, extend: boolean) {
    setRange((current) => ({
      anchorRow: 0,
      anchorColumn: extend && current ? current.anchorColumn : columnIndex,
      focusRow: Math.max(0, rows.length - 1),
      focusColumn: columnIndex,
    }));
  }

  function selectWholeRow(rowIndex: number, extend: boolean) {
    setRange((current) => ({
      anchorRow: extend && current ? current.anchorRow : rowIndex,
      anchorColumn: 0,
      focusRow: rowIndex,
      focusColumn: Math.max(0, columns.length - 1),
    }));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copySelection(event.shiftKey ? 'markdown' : 'csv');
      return;
    }
    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setRange({
        anchorRow: 0,
        anchorColumn: 0,
        focusRow: Math.max(0, rows.length - 1),
        focusColumn: Math.max(0, columns.length - 1),
      });
      return;
    }
    if (event.key === 'Escape') {
      setRange(null);
      return;
    }

    const delta = ARROW_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();

    const current = range ?? {
      anchorRow: 0,
      anchorColumn: 0,
      focusRow: 0,
      focusColumn: 0,
    };
    const focusRow = clamp(current.focusRow + delta.row, 0, rows.length - 1);
    const focusColumn = clamp(current.focusColumn + delta.column, 0, columns.length - 1);
    setRange(
      event.shiftKey
        ? { ...current, focusRow, focusColumn }
        : { anchorRow: focusRow, anchorColumn: focusColumn, focusRow, focusColumn },
    );
    virtualizer.scrollToIndex(focusRow, { align: 'auto' });
  }

  const totalWidth =
    GUTTER_WIDTH +
    columns.reduce((sum, column) => sum + (widths[column.name] ?? DEFAULT_COLUMN_WIDTH), 0);

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--color-ink-muted)]">
        The statement ran successfully and returned no columns.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div
          ref={gridRef}
          role="grid"
          aria-rowcount={rows.length + 1}
          aria-colcount={columns.length}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerUp={() => (dragging.current = false)}
          className="outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] focus-visible:ring-inset"
          style={{ width: totalWidth, minWidth: '100%' }}
        >
          {/* Sticky header so column names survive a long scroll. */}
          <div
            role="row"
            className="sticky top-0 z-10 flex border-b border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <div
              className="shrink-0 border-r border-[var(--color-border)] px-2 py-1.5 text-[10px] text-[var(--color-ink-muted)]"
              style={{ width: GUTTER_WIDTH }}
              aria-hidden
            >
              #
            </div>
            {columns.map((column, columnIndex) => {
              const width = widths[column.name] ?? DEFAULT_COLUMN_WIDTH;
              const sorted = sort?.column === column.name;
              const inSelection =
                bounds !== null && columnIndex >= bounds.left && columnIndex <= bounds.right;
              return (
                <div
                  key={column.name}
                  role="columnheader"
                  aria-sort={
                    sorted ? (sort.descending ? 'descending' : 'ascending') : onSort ? 'none' : undefined
                  }
                  className={cn(
                    'relative flex shrink-0 items-center gap-1 px-2 py-1.5 text-xs font-medium',
                    inSelection && 'bg-[var(--color-surface-raised)]',
                  )}
                  style={{ width }}
                >
                  <TypeIcon kind={column.kind} />
                  <button
                    type="button"
                    onClick={(event) => {
                      // Sortable grids sort on header click; unsorted ones use
                      // the same click to select the column, so the affordance
                      // is never wasted.
                      if (onSort) onSort(column);
                      else selectWholeColumn(columnIndex, event.shiftKey);
                    }}
                    onDoubleClick={(event) => selectWholeColumn(columnIndex, event.shiftKey)}
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
              const rowSelected =
                bounds !== null &&
                virtualRow.index >= bounds.top &&
                virtualRow.index <= bounds.bottom;
              return (
                <div
                  key={virtualRow.key}
                  role="row"
                  aria-rowindex={virtualRow.index + 2}
                  className="absolute top-0 left-0 flex w-full border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface)]/60"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    onPointerDown={(event) => selectWholeRow(virtualRow.index, event.shiftKey)}
                    className={cn(
                      'shrink-0 cursor-pointer border-r border-[var(--color-border)] px-2 py-1 text-right font-mono text-[10px] text-[var(--color-ink-muted)] select-none',
                      rowSelected && 'bg-[var(--color-surface-raised)]',
                    )}
                    style={{ width: GUTTER_WIDTH }}
                    aria-hidden
                  >
                    {formatCount(rowOffset + virtualRow.index + 1)}
                  </div>

                  {columns.map((column, columnIndex) => {
                    const value = row[columnIndex];
                    const selected =
                      bounds !== null &&
                      rowSelected &&
                      columnIndex >= bounds.left &&
                      columnIndex <= bounds.right;
                    return (
                      <div
                        role="gridcell"
                        key={column.name}
                        aria-selected={selected}
                        onPointerDown={(event) => {
                          dragging.current = true;
                          selectCell(virtualRow.index, columnIndex, event.shiftKey);
                        }}
                        onPointerEnter={() => {
                          if (dragging.current) selectCell(virtualRow.index, columnIndex, true);
                        }}
                        onDoubleClick={() => void copyCell(value)}
                        title={value === null ? 'NULL' : String(value)}
                        className={cn(
                          'shrink-0 cursor-default truncate px-2 py-1 text-left font-mono text-xs select-none',
                          column.kind === 'number' && 'text-right',
                          value === null && 'text-[var(--color-ink-muted)] italic',
                          selected && 'bg-[var(--color-accent)]/20',
                        )}
                        style={{ width: widths[column.name] ?? DEFAULT_COLUMN_WIDTH }}
                      >
                        {value === null ? 'NULL' : String(value)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-ink-muted)]">
        {footer}
        {bounds && (
          <span>
            {formatCount(bounds.bottom - bounds.top + 1)} × {bounds.right - bounds.left + 1}{' '}
            selected
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {loading && <Loader2 className="size-3 animate-spin" />}
          <button
            type="button"
            onClick={() => void copySelection('csv')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
            title="Copy selection as CSV (Cmd/Ctrl+C)"
          >
            <Copy className="size-3" /> CSV
          </button>
          <button
            type="button"
            onClick={() => void copySelection('markdown')}
            className="rounded px-1.5 py-0.5 hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
            title="Copy selection as Markdown (Cmd/Ctrl+Shift+C)"
          >
            Markdown
          </button>
        </div>
      </div>
    </div>
  );
}

async function copyCell(value: unknown): Promise<void> {
  try {
    await navigator.clipboard.writeText(value === null ? '' : String(value));
    toast.success('Copied to clipboard');
  } catch {
    toast.error('The browser blocked clipboard access');
  }
}

const ARROW_DELTAS: Record<string, { row: number; column: number } | undefined> = {
  ArrowUp: { row: -1, column: 0 },
  ArrowDown: { row: 1, column: 0 },
  ArrowLeft: { row: 0, column: -1 },
  ArrowRight: { row: 0, column: 1 },
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Anchor/focus can point in any direction; the renderer wants a rectangle. */
function normalize(
  range: CellRange | null,
): { top: number; bottom: number; left: number; right: number } | null {
  if (!range) return null;
  return {
    top: Math.min(range.anchorRow, range.focusRow),
    bottom: Math.max(range.anchorRow, range.focusRow),
    left: Math.min(range.anchorColumn, range.focusColumn),
    right: Math.max(range.anchorColumn, range.focusColumn),
  };
}

/** Drag handle on a column's trailing edge. */
function ColumnResizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
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
