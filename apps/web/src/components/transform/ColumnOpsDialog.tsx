'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { CONTROL_CLASS, Field } from '@/components/ui/Field';
import { getEngine } from '@/lib/engine/engine';
import type { ColumnSchema } from '@/lib/engine/types';
import {
  CAST_TARGET_TYPES,
  compileCastColumn,
  compileDropColumn,
  compileRenameColumn,
  compileReorderColumns,
} from '@/lib/sql/transform';
import { cn } from '@/lib/utils/cn';

type Operation = 'rename' | 'cast' | 'drop' | 'reorder';

interface Props {
  table: string;
  columns: ColumnSchema[];
  /** Pre-selected column when opened from a column's own menu. */
  column?: string;
  operation?: Operation;
  onClose: () => void;
  onApplied: () => void;
}

const LABELS: Record<Operation, string> = {
  rename: 'Rename column',
  cast: 'Change column type',
  drop: 'Drop column',
  reorder: 'Reorder columns',
};

/**
 * Structural edits to a table's columns.
 *
 * Unlike the query builders these mutate the table in place, so they run
 * immediately rather than opening in the editor — but the SQL is still shown
 * first, and destructive ones say what will be lost. There is no undo: the
 * source file is still in OPFS, so the recovery path is re-importing, and the
 * dialog says as much rather than implying a safety net that isn't there.
 */
export function ColumnOpsDialog({
  table,
  columns,
  column: initialColumn,
  operation: initialOperation = 'rename',
  onClose,
  onApplied,
}: Props) {
  const [operation, setOperation] = useState<Operation>(initialOperation);
  const [column, setColumn] = useState(initialColumn ?? columns[0]?.name ?? '');
  const [newName, setNewName] = useState(initialColumn ?? '');
  const [type, setType] = useState<string>(CAST_TARGET_TYPES[0]);
  const [order, setOrder] = useState<string[]>(() => columns.map((item) => item.name));
  const [busy, setBusy] = useState(false);

  const sql = useMemo(() => {
    switch (operation) {
      case 'rename':
        return newName.trim() && column ? compileRenameColumn(table, column, newName.trim()) : '';
      case 'cast':
        return column ? compileCastColumn(table, column, type) : '';
      case 'drop':
        return column ? compileDropColumn(table, column) : '';
      case 'reorder':
        return compileReorderColumns(table, order);
    }
  }, [operation, table, column, newName, type, order]);

  async function apply() {
    if (!sql) return;
    setBusy(true);
    try {
      await getEngine().exec(sql);
      toast.success(`${LABELS[operation]} applied to ${table}`);
      onApplied();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The change could not be applied');
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setOrder(next);
  }

  return (
    <Dialog
      title={`${LABELS[operation]} · ${table}`}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={operation === 'drop' ? 'danger' : 'primary'}
            busy={busy}
            disabled={!sql}
            onClick={() => void apply()}
          >
            {operation === 'drop' ? 'Drop column' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {(Object.keys(LABELS) as Operation[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setOperation(candidate)}
              className={cn(
                'rounded px-2 py-1 text-xs',
                operation === candidate
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)]',
              )}
            >
              {LABELS[candidate]}
            </button>
          ))}
        </div>

        {operation !== 'reorder' && (
          <Field label="Column">
            {({ id, className }) => (
              <select
                id={id}
                className={className}
                value={column}
                onChange={(event) => {
                  setColumn(event.target.value);
                  setNewName(event.target.value);
                }}
              >
                {columns.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.type}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {operation === 'rename' && (
          <Field label="New name">
            {({ id, className }) => (
              <input
                id={id}
                className={`${className} font-mono`}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            )}
          </Field>
        )}

        {operation === 'cast' && (
          <Field
            label="New type"
            hint="Values that can't be converted become NULL rather than failing the whole change."
          >
            {({ id, className }) => (
              <select
                id={id}
                className={className}
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {CAST_TARGET_TYPES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {operation === 'drop' && (
          <p className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-2 text-xs">
            This removes the column from the loaded table. Your original file is untouched — you
            can re-import it to get the column back.
          </p>
        )}

        {operation === 'reorder' && (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {order.map((name, index) => (
              <li
                key={name}
                className="flex items-center gap-2 rounded border border-[var(--color-border)] px-2 py-1"
              >
                <span className="flex-1 truncate font-mono text-xs">{name}</span>
                <Button
                  size="sm"
                  aria-label={`Move ${name} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  size="sm"
                  aria-label={`Move ${name} down`}
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <p className="mb-1 text-xs font-medium">Generated SQL</p>
          <pre className={cn(CONTROL_CLASS, 'overflow-auto font-mono text-[11px] whitespace-pre-wrap')}>
            {sql || '—'}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}
