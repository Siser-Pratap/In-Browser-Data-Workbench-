'use client';

import { useMemo } from 'react';

import { Chart } from '@/components/charts/Chart';
import { useChartData } from '@/components/charts/useChartData';
import { CONTROL_CLASS } from '@/components/ui/Field';
import { RAW_POINT_CAP, aggregates, isAllPairsForm, type ChartSpec, type ChartType, type NumberFormat } from '@/lib/charts/spec';
import { CHART_TYPE_LABELS } from '@/lib/charts/spec';
import { ALL_PAIRS_SERIES_CAP } from '@/lib/charts/spec';
import type { ColumnSchema } from '@/lib/engine/types';
import { AGGREGATE_LABELS, type AggregateFunction } from '@/lib/sql/transform';
import { cn } from '@/lib/utils/cn';

interface Props {
  spec: ChartSpec;
  /** Columns of the query the chart is built on. */
  columns: ColumnSchema[];
  onChange: (spec: ChartSpec) => void;
  /** Rendered in the panel's header — "add to dashboard", exports. */
  actions?: React.ReactNode;
}

const CHART_TYPES: ChartType[] = [
  'bar',
  'line',
  'area',
  'scatter',
  'pie',
  'histogram',
  'kpi',
  'table',
];

/**
 * The encoding panel plus a live preview.
 *
 * Every control writes to the spec and the spec recompiles to SQL, so the chart
 * on the right is always the chart the saved spec would produce — there is no
 * separate "apply". The aggregation dropdown in particular is not a display
 * option: it changes the GROUP BY, so the numbers come from DuckDB and never
 * from summing in JavaScript.
 */
export function ChartBuilder({ spec, columns, onChange, actions }: Props) {
  const data = useChartData(spec);

  const numeric = useMemo(
    () => columns.filter((column) => column.kind === 'number'),
    [columns],
  );

  function patch(changes: Partial<ChartSpec>) {
    onChange({ ...spec, ...changes });
  }
  function patchEncoding(changes: Partial<ChartSpec['encoding']>) {
    onChange({ ...spec, encoding: { ...spec.encoding, ...changes } });
  }
  function patchOptions(changes: Partial<ChartSpec['options']>) {
    onChange({ ...spec, options: { ...spec.options, ...changes } });
  }

  const usesAxes = spec.type !== 'kpi' && spec.type !== 'table';
  const grouping = aggregates(spec.type);

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 space-y-3 overflow-y-auto border-r border-[var(--color-border)] p-3">
        <Group label="Chart type">
          <div className="grid grid-cols-2 gap-1">
            {CHART_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={spec.type === type}
                onClick={() => patch({ type })}
                className={cn(
                  'rounded px-2 py-1 text-[11px]',
                  spec.type === type
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-ink)]'
                    : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)]',
                )}
              >
                {CHART_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </Group>

        {spec.type !== 'kpi' && (
          <Group label={spec.type === 'histogram' ? 'Value to bucket' : 'Horizontal axis'}>
            <ColumnSelect
              value={spec.encoding.x}
              columns={spec.type === 'histogram' || spec.type === 'scatter' ? numeric : columns}
              onChange={(x) => patchEncoding({ x })}
            />
          </Group>
        )}

        {spec.type !== 'histogram' && spec.type !== 'table' && (
          <Group label={spec.type === 'kpi' ? 'Value' : 'Vertical axis'}>
            <ColumnSelect
              value={spec.encoding.y}
              columns={grouping ? columns : numeric}
              onChange={(y) => patchEncoding({ y })}
            />
            {grouping && (
              <select
                aria-label="Aggregation"
                value={spec.encoding.aggregate}
                onChange={(event) =>
                  patchEncoding({ aggregate: event.target.value as AggregateFunction | 'none' })
                }
                className={cn(CONTROL_CLASS, 'mt-1 text-xs')}
              >
                <option value="none">no aggregation</option>
                {Object.entries(AGGREGATE_LABELS).map(([fn, label]) => (
                  <option key={fn} value={fn}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Group>
        )}

        {usesAxes && spec.type !== 'histogram' && (
          <Group
            label="Split into series"
            hint={
              isAllPairsForm(spec.type)
                ? `Capped at ${ALL_PAIRS_SERIES_CAP} on a scatter — beyond that the colours stop being reliably distinguishable.`
                : undefined
            }
          >
            <ColumnSelect
              value={spec.encoding.series}
              columns={columns}
              allowNone
              onChange={(series) => patchEncoding({ series })}
            />
          </Group>
        )}

        {spec.type === 'scatter' && (
          <Group label="Point size">
            <ColumnSelect
              value={spec.encoding.size}
              columns={numeric}
              allowNone
              onChange={(size) => patchEncoding({ size })}
            />
          </Group>
        )}

        <Group label="Title">
          <input
            aria-label="Chart title"
            value={spec.options.title}
            placeholder="Untitled chart"
            onChange={(event) => patchOptions({ title: event.target.value })}
            className={cn(CONTROL_CLASS, 'text-xs')}
          />
        </Group>

        {usesAxes && (
          <Group label="Axis labels">
            <input
              aria-label="Horizontal axis label"
              value={spec.options.xLabel}
              placeholder="horizontal"
              onChange={(event) => patchOptions({ xLabel: event.target.value })}
              className={cn(CONTROL_CLASS, 'text-xs')}
            />
            <input
              aria-label="Vertical axis label"
              value={spec.options.yLabel}
              placeholder="vertical"
              onChange={(event) => patchOptions({ yLabel: event.target.value })}
              className={cn(CONTROL_CLASS, 'mt-1 text-xs')}
            />
          </Group>
        )}

        <Group label="Numbers">
          <select
            aria-label="Number format"
            value={spec.options.numberFormat}
            onChange={(event) =>
              patchOptions({ numberFormat: event.target.value as NumberFormat })
            }
            className={cn(CONTROL_CLASS, 'text-xs')}
          >
            <option value="compact">compact (1.2K)</option>
            <option value="plain">plain (1,234)</option>
            <option value="percent">percent</option>
          </select>
        </Group>

        {usesAxes && (
          <Group label="Legend">
            <select
              aria-label="Legend position"
              value={spec.options.legend}
              onChange={(event) =>
                patchOptions({ legend: event.target.value as ChartSpec['options']['legend'] })
              }
              className={cn(CONTROL_CLASS, 'text-xs')}
            >
              <option value="top">top</option>
              <option value="right">right</option>
              <option value="bottom">bottom</option>
              <option value="none">hidden</option>
            </select>
          </Group>
        )}

        {(spec.type === 'bar' || spec.type === 'area') && (
          <Toggle
            label="Stack the series"
            checked={spec.options.stacked}
            onChange={(stacked) => patchOptions({ stacked })}
          />
        )}

        {spec.type === 'pie' && (
          <Toggle
            label="Donut"
            checked={spec.options.donut}
            onChange={(donut) => patchOptions({ donut })}
          />
        )}

        {usesAxes && spec.type !== 'pie' && (
          <Toggle
            label="Logarithmic vertical axis"
            checked={spec.options.logScale}
            onChange={(logScale) => patchOptions({ logScale })}
            hint="Ignored when any value is zero or negative."
          />
        )}

        {spec.type === 'histogram' && (
          <Group label="Buckets">
            <input
              type="number"
              min={2}
              max={200}
              aria-label="Bucket count"
              value={spec.options.bins}
              onChange={(event) => patchOptions({ bins: Number(event.target.value) })}
              className={cn(CONTROL_CLASS, 'text-xs')}
            />
          </Group>
        )}

        {spec.type !== 'kpi' && spec.type !== 'histogram' && (
          <Group
            label={spec.type === 'scatter' ? 'Sample size' : 'Show at most'}
            hint={
              spec.type === 'scatter'
                ? `DuckDB samples down to this many points (max ${RAW_POINT_CAP.toLocaleString()}).`
                : 'The top N by value; the rest are not fetched.'
            }
          >
            <input
              type="number"
              min={1}
              max={RAW_POINT_CAP}
              aria-label="Row limit"
              value={spec.options.limit}
              onChange={(event) => patchOptions({ limit: Number(event.target.value) })}
              className={cn(CONTROL_CLASS, 'text-xs')}
            />
          </Group>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {actions && (
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3 py-1.5">
            {actions}
          </div>
        )}
        <div className="min-h-0 flex-1 p-2">
          <Chart spec={spec} result={data.result} error={data.error} loading={data.loading} />
        </div>
      </div>
    </div>
  );
}

function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-[var(--color-ink-muted)]">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {hint && <p className="mt-0.5 ml-5 text-[10px] text-[var(--color-ink-muted)]">{hint}</p>}
    </div>
  );
}

function ColumnSelect({
  value,
  columns,
  onChange,
  allowNone = false,
}: {
  value: string | null;
  columns: ColumnSchema[];
  onChange: (value: string | null) => void;
  allowNone?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className={cn(CONTROL_CLASS, 'text-xs')}
    >
      <option value="">{allowNone ? 'none' : 'choose a column…'}</option>
      {columns.map((column) => (
        <option key={column.name} value={column.name}>
          {column.name}
        </option>
      ))}
    </select>
  );
}
