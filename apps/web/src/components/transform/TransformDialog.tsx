'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { CONTROL_CLASS, Field } from '@/components/ui/Field';
import type { ColumnSchema } from '@/lib/engine/types';
import {
  AGGREGATE_LABELS,
  EXPRESSION_PALETTE,
  FILTER_OPERATOR_LABELS,
  UNARY_OPERATORS,
  compileTransform,
  defaultAlias,
  type AggregateFunction,
  type AggregateSpec,
  type DeriveSpec,
  type FilterOperator,
  type FilterSpec,
  type JoinSpec,
  type JoinType,
  type TransformSpec,
} from '@/lib/sql/transform';
import { track } from '@/lib/telemetry/telemetry';
import { cn } from '@/lib/utils/cn';
import { useCatalogStore } from '@/stores/catalog';

export type TransformKind = TransformSpec['kind'];

interface Props {
  kind: TransformKind;
  table: string;
  onClose: () => void;
  /** Hand the generated SQL to a query tab; the user runs it from there. */
  onOpenInEditor: (sql: string) => void;
}

const TITLES: Record<TransformKind, string> = {
  filter: 'Filter rows',
  derive: 'Add a derived column',
  aggregate: 'Group and summarise',
  join: 'Join two tables',
};

const DESCRIPTIONS: Record<TransformKind, string> = {
  filter: 'Keep only the rows that match your conditions.',
  derive: 'Compute a new column from the existing ones.',
  aggregate: 'Roll rows up into one row per group.',
  join: 'Match rows in one table against another.',
};

/**
 * The no-code transformation builders.
 *
 * The generated SQL is not hidden behind a "show me" toggle — it's on screen
 * the whole time, updating as the form changes. That's the point of the whole
 * layer: someone who doesn't write SQL gets their answer *and* sees the query
 * that produced it, so the tool teaches instead of substituting. The only exit
 * is "Open in editor", which is also why there's no Apply button — nothing runs
 * without the user reading the SQL and pressing Run themselves.
 */
export function TransformDialog({ kind, table, onClose, onOpenInEditor }: Props) {
  const catalog = useCatalogStore((state) => state.tables);
  const columnsOf = useMemo(
    () => (name: string) => catalog.find((entry) => entry.name === name)?.columns ?? [],
    [catalog],
  );
  const columns = columnsOf(table);

  const [spec, setSpec] = useState<TransformSpec>(() => initialSpec(kind, table, catalog[0]?.name));

  const sql = useMemo(() => {
    try {
      return compileTransform(spec, columns);
    } catch (error) {
      return `-- ${error instanceof Error ? error.message : 'Could not build this query'}`;
    }
  }, [spec, columns]);

  return (
    <Dialog
      title={TITLES[kind]}
      description={DESCRIPTIONS[kind]}
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              track('transform.build');
              onOpenInEditor(sql);
            }}
          >
            Open in editor
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {spec.kind === 'filter' && (
          <FilterForm spec={spec} columns={columns} onChange={setSpec} />
        )}
        {spec.kind === 'derive' && <DeriveForm spec={spec} columns={columns} onChange={setSpec} />}
        {spec.kind === 'aggregate' && (
          <AggregateForm spec={spec} columns={columns} onChange={setSpec} />
        )}
        {spec.kind === 'join' && (
          <JoinForm
            spec={spec}
            tables={catalog.map((entry) => entry.name)}
            columnsOf={columnsOf}
            onChange={setSpec}
          />
        )}

        <div>
          <p className="mb-1 text-xs font-medium">Generated SQL</p>
          <pre className="max-h-48 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] whitespace-pre-wrap">
            {sql}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}

function initialSpec(kind: TransformKind, table: string, otherTable?: string): TransformSpec {
  switch (kind) {
    case 'filter':
      return {
        kind: 'filter',
        table,
        combinator: 'AND',
        conditions: [{ column: '', operator: '=', value: '' }],
      };
    case 'derive':
      return { kind: 'derive', table, name: 'new_column', expression: '' };
    case 'aggregate':
      return {
        kind: 'aggregate',
        table,
        groupBy: [],
        aggregations: [{ fn: 'count', column: '*' }],
        orderBy: null,
        limit: null,
      };
    case 'join':
      return {
        kind: 'join',
        left: table,
        right: otherTable && otherTable !== table ? otherTable : table,
        type: 'INNER',
        keys: [{ left: '', right: '' }],
      };
  }
}

// ---------------------------------------------------------------------------

function FilterForm({
  spec,
  columns,
  onChange,
}: {
  spec: FilterSpec;
  columns: ColumnSchema[];
  onChange: (spec: FilterSpec) => void;
}) {
  function update(index: number, patch: Partial<FilterSpec['conditions'][number]>) {
    onChange({
      ...spec,
      conditions: spec.conditions.map((condition, i) =>
        i === index ? { ...condition, ...patch } : condition,
      ),
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--color-ink-muted)]">Match</span>
        {(['AND', 'OR'] as const).map((combinator) => (
          <button
            key={combinator}
            type="button"
            onClick={() => onChange({ ...spec, combinator })}
            className={cn(
              'rounded px-2 py-0.5',
              spec.combinator === combinator
                ? 'bg-[var(--color-accent)] text-[var(--color-accent-ink)]'
                : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)]',
            )}
          >
            {combinator === 'AND' ? 'all conditions' : 'any condition'}
          </button>
        ))}
      </div>

      {spec.conditions.map((condition, index) => (
        <div key={index} className="flex items-center gap-2">
          <select
            aria-label="Column"
            value={condition.column}
            onChange={(event) => update(index, { column: event.target.value })}
            className={cn(CONTROL_CLASS, 'flex-1')}
          >
            <option value="">Choose a column…</option>
            {columns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>

          <select
            aria-label="Operator"
            value={condition.operator}
            onChange={(event) =>
              update(index, { operator: event.target.value as FilterOperator })
            }
            className={cn(CONTROL_CLASS, 'w-40')}
          >
            {Object.entries(FILTER_OPERATOR_LABELS).map(([operator, label]) => (
              <option key={operator} value={operator}>
                {label}
              </option>
            ))}
          </select>

          <input
            aria-label="Value"
            value={condition.value}
            disabled={UNARY_OPERATORS.has(condition.operator)}
            placeholder={condition.operator === 'in' ? 'a, b, c' : 'value'}
            onChange={(event) => update(index, { value: event.target.value })}
            className={cn(CONTROL_CLASS, 'flex-1 disabled:opacity-40')}
          />

          <Button
            variant="danger"
            size="sm"
            aria-label="Remove condition"
            disabled={spec.conditions.length === 1}
            onClick={() =>
              onChange({ ...spec, conditions: spec.conditions.filter((_, i) => i !== index) })
            }
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}

      <Button
        size="sm"
        icon={<Plus className="size-3" />}
        onClick={() =>
          onChange({
            ...spec,
            conditions: [...spec.conditions, { column: '', operator: '=', value: '' }],
          })
        }
      >
        Add condition
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeriveForm({
  spec,
  columns,
  onChange,
}: {
  spec: DeriveSpec;
  columns: ColumnSchema[];
  onChange: (spec: DeriveSpec) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="New column name">
        {({ id, className }) => (
          <input
            id={id}
            className={`${className} font-mono`}
            value={spec.name}
            onChange={(event) => onChange({ ...spec, name: event.target.value })}
          />
        )}
      </Field>

      <Field label="Expression" hint="Any SQL scalar expression over this table's columns.">
        {({ id, className }) => (
          <textarea
            id={id}
            rows={3}
            className={`${className} font-mono`}
            placeholder="upper(name)"
            value={spec.expression}
            onChange={(event) => onChange({ ...spec, expression: event.target.value })}
          />
        )}
      </Field>

      <div>
        <p className="mb-1 text-xs font-medium">Functions</p>
        <div className="flex flex-wrap gap-1">
          {EXPRESSION_PALETTE.map((entry) => (
            <button
              key={entry.label}
              type="button"
              title={entry.hint}
              onClick={() =>
                onChange({
                  ...spec,
                  expression: spec.expression ? `${spec.expression} ${entry.snippet}` : entry.snippet,
                })
              }
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium">Columns</p>
        <div className="flex flex-wrap gap-1">
          {columns.map((column) => (
            <button
              key={column.name}
              type="button"
              onClick={() =>
                onChange({
                  ...spec,
                  expression: `${spec.expression}${spec.expression ? ' ' : ''}"${column.name}"`,
                })
              }
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
            >
              {column.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AggregateForm({
  spec,
  columns,
  onChange,
}: {
  spec: AggregateSpec;
  columns: ColumnSchema[];
  onChange: (spec: AggregateSpec) => void;
}) {
  const outputColumns = [
    ...spec.groupBy,
    ...spec.aggregations
      .filter((aggregation) => aggregation.column)
      .map((aggregation) => aggregation.alias?.trim() || defaultAlias(aggregation)),
  ];

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-xs font-medium">Group by</p>
        <div className="flex flex-wrap gap-1">
          {columns.map((column) => {
            const selected = spec.groupBy.includes(column.name);
            return (
              <button
                key={column.name}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  onChange({
                    ...spec,
                    groupBy: selected
                      ? spec.groupBy.filter((name) => name !== column.name)
                      : [...spec.groupBy, column.name],
                  })
                }
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[11px]',
                  selected
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-ink)]'
                    : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                )}
              >
                {column.name}
              </button>
            );
          })}
        </div>
        {spec.groupBy.length === 0 && (
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            With nothing selected the whole table becomes one row.
          </p>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs font-medium">Summarise</p>
        <div className="space-y-2">
          {spec.aggregations.map((aggregation, index) => (
            <div key={index} className="flex items-center gap-2">
              <select
                aria-label="Function"
                value={aggregation.fn}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    aggregations: spec.aggregations.map((item, i) =>
                      i === index ? { ...item, fn: event.target.value as AggregateFunction } : item,
                    ),
                  })
                }
                className={cn(CONTROL_CLASS, 'w-40')}
              >
                {Object.entries(AGGREGATE_LABELS).map(([fn, label]) => (
                  <option key={fn} value={fn}>
                    {label}
                  </option>
                ))}
              </select>

              <select
                aria-label="Of column"
                value={aggregation.column}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    aggregations: spec.aggregations.map((item, i) =>
                      i === index ? { ...item, column: event.target.value } : item,
                    ),
                  })
                }
                className={cn(CONTROL_CLASS, 'flex-1')}
              >
                <option value="*">all rows (*)</option>
                {columns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>

              <input
                aria-label="Alias"
                placeholder={defaultAlias(aggregation)}
                value={aggregation.alias ?? ''}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    aggregations: spec.aggregations.map((item, i) =>
                      i === index ? { ...item, alias: event.target.value } : item,
                    ),
                  })
                }
                className={cn(CONTROL_CLASS, 'w-40 font-mono')}
              />

              <Button
                variant="danger"
                size="sm"
                aria-label="Remove aggregation"
                disabled={spec.aggregations.length === 1}
                onClick={() =>
                  onChange({
                    ...spec,
                    aggregations: spec.aggregations.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          className="mt-2"
          icon={<Plus className="size-3" />}
          onClick={() =>
            onChange({ ...spec, aggregations: [...spec.aggregations, { fn: 'sum', column: '' }] })
          }
        >
          Add measure
        </Button>
      </div>

      <div className="flex items-end gap-2">
        <Field label="Sort by" className="flex-1">
          {({ id, className }) => (
            <select
              id={id}
              className={className}
              value={spec.orderBy?.column ?? ''}
              onChange={(event) =>
                onChange({
                  ...spec,
                  orderBy: event.target.value
                    ? { column: event.target.value, descending: spec.orderBy?.descending ?? true }
                    : null,
                })
              }
            >
              <option value="">unsorted</option>
              {outputColumns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Direction" className="w-32">
          {({ id, className }) => (
            <select
              id={id}
              className={className}
              disabled={!spec.orderBy}
              value={spec.orderBy?.descending ? 'desc' : 'asc'}
              onChange={(event) =>
                onChange({
                  ...spec,
                  orderBy: spec.orderBy
                    ? { ...spec.orderBy, descending: event.target.value === 'desc' }
                    : null,
                })
              }
            >
              <option value="desc">highest first</option>
              <option value="asc">lowest first</option>
            </select>
          )}
        </Field>

        <Field label="Limit" className="w-28">
          {({ id, className }) => (
            <input
              id={id}
              type="number"
              min={1}
              className={className}
              placeholder="all"
              value={spec.limit ?? ''}
              onChange={(event) =>
                onChange({ ...spec, limit: event.target.value ? Number(event.target.value) : null })
              }
            />
          )}
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function JoinForm({
  spec,
  tables,
  columnsOf,
  onChange,
}: {
  spec: JoinSpec;
  tables: string[];
  columnsOf: (table: string) => ColumnSchema[];
  onChange: (spec: JoinSpec) => void;
}) {
  const leftColumns = columnsOf(spec.left);
  const rightColumns = columnsOf(spec.right);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <Field label="Left table" className="flex-1">
          {({ id, className }) => (
            <select
              id={id}
              className={className}
              value={spec.left}
              onChange={(event) => onChange({ ...spec, left: event.target.value })}
            >
              {tables.map((table) => (
                <option key={table} value={table}>
                  {table}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Join type" className="w-40">
          {({ id, className }) => (
            <select
              id={id}
              className={className}
              value={spec.type}
              onChange={(event) => onChange({ ...spec, type: event.target.value as JoinType })}
            >
              <option value="INNER">only matching rows</option>
              <option value="LEFT">all left rows</option>
              <option value="RIGHT">all right rows</option>
              <option value="FULL">all rows, both sides</option>
              <option value="CROSS">every combination</option>
            </select>
          )}
        </Field>

        <Field label="Right table" className="flex-1">
          {({ id, className }) => (
            <select
              id={id}
              className={className}
              value={spec.right}
              onChange={(event) => onChange({ ...spec, right: event.target.value })}
            >
              {tables.map((table) => (
                <option key={table} value={table}>
                  {table}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {spec.type !== 'CROSS' && (
        <div>
          <p className="mb-1 text-xs font-medium">Match on</p>
          <div className="space-y-2">
            {spec.keys.map((key, index) => (
              <div key={index} className="flex items-center gap-2">
                <select
                  aria-label="Left key"
                  value={key.left}
                  onChange={(event) =>
                    onChange({
                      ...spec,
                      keys: spec.keys.map((item, i) =>
                        i === index ? { ...item, left: event.target.value } : item,
                      ),
                    })
                  }
                  className={cn(CONTROL_CLASS, 'flex-1')}
                >
                  <option value="">column in {spec.left}…</option>
                  {leftColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </select>

                <span className="text-xs text-[var(--color-ink-muted)]">=</span>

                <select
                  aria-label="Right key"
                  value={key.right}
                  onChange={(event) =>
                    onChange({
                      ...spec,
                      keys: spec.keys.map((item, i) =>
                        i === index ? { ...item, right: event.target.value } : item,
                      ),
                    })
                  }
                  className={cn(CONTROL_CLASS, 'flex-1')}
                >
                  <option value="">column in {spec.right}…</option>
                  {rightColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </select>

                <Button
                  variant="danger"
                  size="sm"
                  aria-label="Remove key pair"
                  disabled={spec.keys.length === 1}
                  onClick={() =>
                    onChange({ ...spec, keys: spec.keys.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            className="mt-2"
            icon={<Plus className="size-3" />}
            onClick={() => onChange({ ...spec, keys: [...spec.keys, { left: '', right: '' }] })}
          >
            Add key pair
          </Button>
        </div>
      )}
    </div>
  );
}
