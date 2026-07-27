'use client';

import { useState } from 'react';
import { BarChart3, ChevronRight, MoreHorizontal, Table2 } from 'lucide-react';
import { toast } from 'sonner';

import { TypeIcon } from '@/components/grid/TypeIcon';
import { ColumnStatsPopover } from '@/components/schema/ColumnStatsPopover';
import { Button } from '@/components/ui/Button';
import { LazyColumnOpsDialog } from '@/components/workbench/lazy';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { insertAtCursor } from '@/lib/editor/bridge';
import { getEngine } from '@/lib/engine/engine';
import type { ColumnSchema } from '@/lib/engine/types';
import { identifier } from '@/lib/sql/completion';
import { cn } from '@/lib/utils/cn';
import { formatBytes, formatCount } from '@/lib/utils/format';
import { useCatalogStore } from '@/stores/catalog';
import { useDatasetStore } from '@/stores/datasets';
import { useTabsStore } from '@/stores/tabs';

/**
 * The schema tree.
 *
 * It lists the *catalogue*, not the imported datasets, so a table created by a
 * `CREATE TABLE AS` or a transformation appears here alongside the files the
 * user dropped in — which is what someone writing SQL needs to see. Dataset
 * metadata (source filename, bytes on disk) is layered on where it exists.
 */
export function SchemaExplorer() {
  const tables = useCatalogStore((state) => state.tables);
  const refreshCatalog = useCatalogStore((state) => state.refresh);
  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);
  const setActiveTable = useDatasetStore((state) => state.setActiveTable);
  const removeDataset = useDatasetStore((state) => state.removeDataset);
  const openTab = useTabsStore((state) => state.openTab);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [profiling, setProfiling] = useState<{ table: string; column: string } | null>(null);
  const [columnOps, setColumnOps] = useState<{ table: string; column?: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  function toggle(table: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  }

  /**
   * Clicking a name types it into the editor when there is one, and copies it
   * otherwise — the intent ("I want this name") is the same either way, so the
   * click shouldn't do nothing just because no editor is open.
   */
  async function insertName(name: string) {
    const text = identifier(name);
    if (insertAtCursor(text)) return;
    await navigator.clipboard.writeText(text).catch(() => undefined);
    toast.success(`Copied ${text}`);
  }

  async function dropTable(table: string) {
    if (!window.confirm(`Drop the table “${table}”? This cannot be undone.`)) return;
    const dataset = datasets.find((item) => item.table === table);
    if (dataset) await removeDataset(table);
    else await getEngine().dropTable(table);
    await refreshCatalog();
    toast.success(`Dropped ${table}`);
  }

  if (tables.length === 0) {
    return (
      <p className="px-3 pb-3 text-xs text-[var(--color-ink-muted)]">
        No tables yet. Drop a file to get started.
      </p>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto pb-2">
      {tables.map((table) => {
        const isOpen = expanded.has(table.name);
        const isActive = table.name === activeTable;
        const dataset = datasets.find((item) => item.table === table.name);

        return (
          <div key={table.name}>
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
                onClick={() => toggle(table.name)}
                className="rounded p-0.5 hover:text-[var(--color-ink)]"
                aria-label={isOpen ? `Collapse ${table.name}` : `Expand ${table.name}`}
                aria-expanded={isOpen}
              >
                <ChevronRight
                  className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
                />
              </button>

              <button
                type="button"
                onClick={() => setActiveTable(table.name)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={dataset?.sourceFilename ?? 'Created in this session'}
              >
                <Table2 className="size-3.5 shrink-0" />
                <span className="truncate font-medium">{table.name}</span>
              </button>

              <Menu
                align="right"
                title={`Actions for ${table.name}`}
                label={<MoreHorizontal className="size-3.5" />}
                items={[
                  {
                    label: 'Preview rows',
                    onSelect: () => setActiveTable(table.name),
                  },
                  {
                    label: 'Query this table',
                    onSelect: () =>
                      openTab({
                        name: table.name,
                        sql: `SELECT *\nFROM ${identifier(table.name)}\nLIMIT 100`,
                        run: true,
                      }),
                  },
                  {
                    label: 'Copy name',
                    onSelect: () => void insertName(table.name),
                  },
                  { label: 'Edit columns…', onSelect: () => setColumnOps({ table: table.name }) },
                  { label: 'Rename table…', onSelect: () => setRenaming(table.name) },
                  {
                    label: 'Drop table',
                    danger: true,
                    onSelect: () => void dropTable(table.name),
                  },
                ]}
              />
            </div>

            <div className="px-2 pb-1 pl-8 text-[11px] text-[var(--color-ink-muted)]">
              {dataset
                ? `${formatCount(dataset.rowCount)} rows · ${table.columns.length} cols · ${formatBytes(dataset.byteSize)}`
                : `${table.columns.length} cols · created in this session`}
            </div>

            {isOpen && (
              <ul className="pb-2 pl-6">
                {table.columns.map((column) => (
                  <ColumnRow
                    key={column.name}
                    table={table.name}
                    column={column}
                    profiling={
                      profiling?.table === table.name && profiling.column === column.name
                    }
                    onToggleProfile={() =>
                      setProfiling((current) =>
                        current?.table === table.name && current.column === column.name
                          ? null
                          : { table: table.name, column: column.name },
                      )
                    }
                    onInsert={() => void insertName(column.name)}
                    onEdit={() => setColumnOps({ table: table.name, column: column.name })}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {columnOps && (
        <LazyColumnOpsDialog
          table={columnOps.table}
          column={columnOps.column}
          columns={tables.find((item) => item.name === columnOps.table)?.columns ?? []}
          onClose={() => setColumnOps(null)}
          onApplied={() => {
            setColumnOps(null);
            void refreshCatalog();
          }}
        />
      )}

      {renaming && (
        <RenameTableDialog
          table={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refreshCatalog();
          }}
        />
      )}
    </div>
  );
}

function ColumnRow({
  table,
  column,
  profiling,
  onToggleProfile,
  onInsert,
  onEdit,
}: {
  table: string;
  column: ColumnSchema;
  profiling: boolean;
  onToggleProfile: () => void;
  onInsert: () => void;
  onEdit: () => void;
}) {
  return (
    <li className="relative">
      <div className="group flex items-center gap-1.5 py-0.5 text-xs text-[var(--color-ink-muted)]">
        <TypeIcon kind={column.kind} />
        <button
          type="button"
          onClick={onInsert}
          title={`${column.name} · ${column.type} — click to insert into the editor`}
          className="min-w-0 flex-1 truncate text-left hover:text-[var(--color-ink)]"
        >
          {column.name}
        </button>
        <span className="shrink-0 text-[10px] opacity-60">{column.type}</span>
        <button
          type="button"
          onClick={onToggleProfile}
          aria-expanded={profiling}
          aria-label={`Profile ${column.name}`}
          className={cn(
            'shrink-0 rounded p-0.5 hover:text-[var(--color-ink)]',
            profiling ? 'text-[var(--color-accent)]' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
        >
          <BarChart3 className="size-3" />
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${column.name}`}
          className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-[var(--color-ink)] focus:opacity-100"
        >
          <MoreHorizontal className="size-3" />
        </button>
      </div>

      {profiling && (
        <div className="mb-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          <ColumnStatsPopover table={table} column={column.name} />
        </div>
      )}
    </li>
  );
}

function RenameTableDialog({
  table,
  onClose,
  onRenamed,
}: {
  table: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(table);
  const [busy, setBusy] = useState(false);

  async function rename() {
    setBusy(true);
    try {
      await getEngine().renameTable(table, name.trim());
      toast.success(`Renamed to ${name.trim()}`);
      onRenamed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Rename failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Rename ${table}`}
      description="Queries and charts that reference the old name will need updating."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim() || name.trim() === table}
            onClick={() => void rename()}
          >
            Rename
          </Button>
        </>
      }
    >
      <Field label="New name">
        {({ id, className }) => (
          <input
            id={id}
            className={`${className} font-mono`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}
