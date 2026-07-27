'use client';

import { cn } from '@/lib/utils/cn';
import { formatCount, formatDuration } from '@/lib/utils/format';
import { useDatasetStore } from '@/stores/datasets';
import type { EngineStatus } from '@/lib/engine/types';

interface Props {
  /** Stats for the visible preview, when there is one. */
  visibleRows?: number;
  elapsedMs?: number;
}

const STATUS_LABEL: Record<EngineStatus, string> = {
  idle: 'Engine idle',
  initializing: 'Starting engine…',
  ready: 'Engine ready',
  error: 'Engine failed',
};

const STATUS_COLOR: Record<EngineStatus, string> = {
  idle: 'bg-[var(--color-ink-muted)]',
  initializing: 'bg-[var(--color-warn)] animate-pulse',
  ready: 'bg-[var(--color-ok)]',
  error: 'bg-[var(--color-danger)]',
};

export function StatusBar({ visibleRows, elapsedMs }: Props) {
  const status = useDatasetStore((state) => state.status);
  const error = useDatasetStore((state) => state.error);
  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);

  const active = datasets.find((dataset) => dataset.table === activeTable);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[11px] text-[var(--color-ink-muted)]">
      <span className="flex items-center gap-1.5" title={error ?? undefined}>
        <span className={cn('size-2 rounded-full', STATUS_COLOR[status])} aria-hidden />
        {STATUS_LABEL[status]}
      </span>

      {active && (
        <>
          <span aria-hidden>·</span>
          <span>
            {active.table}: {formatCount(active.rowCount)} rows × {active.columns.length} cols
          </span>
        </>
      )}

      {visibleRows !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span>{formatCount(visibleRows)} shown</span>
        </>
      )}

      {elapsedMs !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span>query {formatDuration(elapsedMs)}</span>
        </>
      )}

      <span className="ml-auto">{datasets.length} dataset(s)</span>
    </footer>
  );
}
