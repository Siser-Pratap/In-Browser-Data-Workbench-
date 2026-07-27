'use client';

import { useState } from 'react';
import { ChevronRight, Table2, X } from 'lucide-react';
import { toast } from 'sonner';

import { TypeIcon } from '@/components/grid/TypeIcon';
import { cn } from '@/lib/utils/cn';
import { formatBytes, formatCount } from '@/lib/utils/format';
import { useDatasetStore } from '@/stores/datasets';
import { useUiStore } from '@/stores/ui';

export function Sidebar() {
  const open = useUiStore((state) => state.sidebarOpen);
  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);
  const setActiveTable = useDatasetStore((state) => state.setActiveTable);
  const removeDataset = useDatasetStore((state) => state.removeDataset);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!open) return null;

  function toggleExpanded(table: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  }

  async function onRemove(table: string) {
    await removeDataset(table);
    toast.success(`Removed ${table}`);
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-3 py-2 text-[11px] font-semibold tracking-wide text-[var(--color-ink-muted)] uppercase">
        Datasets
      </div>

      {datasets.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-[var(--color-ink-muted)]">
          No data yet. Drop a file to get started.
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto pb-2">
          {datasets.map((dataset) => {
            const isOpen = expanded.has(dataset.table);
            const isActive = dataset.table === activeTable;
            return (
              <div key={dataset.table}>
                <div
                  className={cn(
                    'group flex items-center gap-1 px-2 py-1.5 text-sm',
                    isActive
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]'
                      : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleExpanded(dataset.table)}
                    className="rounded p-0.5 hover:text-[var(--color-ink)]"
                    aria-label={isOpen ? 'Collapse columns' : 'Expand columns'}
                    aria-expanded={isOpen}
                  >
                    <ChevronRight
                      className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
                    />
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTable(dataset.table)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    title={dataset.sourceFilename}
                  >
                    <Table2 className="size-3.5 shrink-0" />
                    <span className="truncate font-medium">{dataset.table}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onRemove(dataset.table)}
                    className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] focus:opacity-100"
                    aria-label={`Remove ${dataset.table}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>

                <div className="px-2 pb-1 pl-8 text-[11px] text-[var(--color-ink-muted)]">
                  {formatCount(dataset.rowCount)} rows · {dataset.columns.length} cols ·{' '}
                  {formatBytes(dataset.byteSize)}
                </div>

                {isOpen && (
                  <ul className="pb-2 pl-8">
                    {dataset.columns.map((column) => (
                      <li
                        key={column.name}
                        className="flex items-center gap-1.5 py-0.5 text-xs text-[var(--color-ink-muted)]"
                        title={`${column.name} · ${column.type}`}
                      >
                        <TypeIcon kind={column.kind} />
                        <span className="truncate">{column.name}</span>
                        <span className="ml-auto shrink-0 pr-2 text-[10px] opacity-60">
                          {column.type}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
