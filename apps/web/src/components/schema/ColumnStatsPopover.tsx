'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { getEngine } from '@/lib/engine/engine';
import type { ColumnStats } from '@/lib/engine/types';
import { formatCount } from '@/lib/utils/format';

interface Props {
  table: string;
  column: string;
}

/**
 * A lazily-computed profile of one column.
 *
 * Computed on open, never on render of the tree: profiling every column of every
 * table up front would mean dozens of aggregate scans the moment a file lands,
 * for numbers nobody has asked to see. The queries themselves are cheap by
 * construction — see `DataEngine.columnStats`, which uses an approximate
 * distinct count precisely so this can open on a hover.
 */
export function ColumnStatsPopover({ table, column }: Props) {
  // One state slot tagged with what it describes, rather than separate
  // stats/error/loading flags: "which column is this about" is then derivable,
  // so switching columns can't briefly show the previous column's numbers.
  const [outcome, setOutcome] = useState<{
    key: string;
    stats: ColumnStats | null;
    error: string | null;
  } | null>(null);

  const key = `${table}.${column}`;
  const current = outcome?.key === key ? outcome : null;

  useEffect(() => {
    let cancelled = false;

    void getEngine()
      .columnStats(table, column)
      .then((stats) => {
        if (!cancelled) setOutcome({ key: `${table}.${column}`, stats, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setOutcome({
          key: `${table}.${column}`,
          stats: null,
          error: cause instanceof Error ? cause.message : 'Could not profile',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [table, column]);

  const stats = current?.stats ?? null;
  const error = current?.error ?? null;

  if (error) {
    return <p className="p-2 text-[11px] text-[var(--color-danger)]">{error}</p>;
  }

  if (!stats) {
    return (
      <p className="flex items-center gap-1.5 p-2 text-[11px] text-[var(--color-ink-muted)]">
        <Loader2 className="size-3 animate-spin" /> Profiling…
      </p>
    );
  }

  const nullShare = stats.rowCount > 0 ? (stats.nullCount / stats.rowCount) * 100 : 0;

  return (
    <div className="w-60 space-y-2 p-2 text-[11px]">
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
        <Stat label="Rows" value={formatCount(stats.rowCount)} />
        <Stat label="Distinct" value={`≈ ${formatCount(stats.distinctCount)}`} />
        <Stat
          label="Nulls"
          value={`${formatCount(stats.nullCount)} (${nullShare.toFixed(nullShare < 1 && nullShare > 0 ? 2 : 0)}%)`}
        />
        <Stat label="Range" value={stats.min === null ? '—' : `${stats.min} … ${stats.max}`} />
      </dl>

      {stats.topValues.length > 0 && (
        <div>
          <p className="mb-1 text-[var(--color-ink-muted)]">Most common</p>
          <ul className="space-y-0.5">
            {stats.topValues.map((entry, index) => {
              const share = stats.rowCount > 0 ? (entry.count / stats.rowCount) * 100 : 0;
              return (
                <li key={index} className="flex items-center gap-1.5">
                  <span className="max-w-28 truncate font-mono" title={entry.value ?? ''}>
                    {entry.value === null || entry.value === '' ? '∅' : entry.value}
                  </span>
                  <span
                    className="h-1.5 rounded-sm bg-[var(--color-accent)]/50"
                    style={{ width: `${Math.max(2, share)}%` }}
                    aria-hidden
                  />
                  <span className="ml-auto shrink-0 text-[var(--color-ink-muted)]">
                    {formatCount(entry.count)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="truncate text-right font-mono" title={value}>
        {value}
      </dd>
    </>
  );
}
