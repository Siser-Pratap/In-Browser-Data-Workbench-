'use client';

import { useState } from 'react';
import { AlertCircle, BarChart3, Download, Loader2, Table2 } from 'lucide-react';
import { toast } from 'sonner';

import { AddToDashboard } from '@/components/dashboards/AddToDashboard';
import { ChartExportMenu } from '@/components/charts/ChartExportMenu';
import { ResultsGrid } from '@/components/grid/ResultsGrid';
import { LazyChartBuilder } from '@/components/workbench/lazy';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { inferSpec, type ChartSpec } from '@/lib/charts/spec';
import { newId } from '@/lib/utils/id';
import { getEngine, MAX_RESULT_ROWS } from '@/lib/engine/engine';
import type { ExportFormat } from '@/lib/engine/types';
import { MIME_TYPES, downloadBytes, safeFilename } from '@/lib/export/download';
import { tableNameFromFilename } from '@/lib/engine/types';
import { track } from '@/lib/telemetry/telemetry';
import { cn } from '@/lib/utils/cn';
import type { TabRuntime } from '@/stores/tabs';
import { useCatalogStore } from '@/stores/catalog';
import { formatCount, formatDuration } from '@/lib/utils/format';

interface Props {
  runtime: TabRuntime;
  /** Used to name exported files. */
  tabName: string;
  /** Put a failed query's text back in front of the user for editing. */
  onOpenInEditor?: (sql: string) => void;
  /** The tab's chart spec, if one has been built. */
  chart: ChartSpec | null;
  onChartChange: (spec: ChartSpec | null) => void;
}

/**
 * What a query produced: the rows, or why there aren't any.
 *
 * Exports and "save as table" deliberately run against `ranSql` rather than the
 * rows on screen. The grid holds at most `MAX_RESULT_ROWS`; the query behind it
 * may match millions, and "export" should mean the result, not the preview.
 */
export function ResultsPanel({
  runtime,
  tabName,
  onOpenInEditor,
  chart,
  onChartChange,
}: Props) {
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'table' | 'chart'>('table');
  const refreshCatalog = useCatalogStore((state) => state.refresh);

  const { status, result, error, ranSql, cancelled } = runtime;

  async function exportAs(format: ExportFormat) {
    if (!ranSql) return;
    setExporting(format);
    try {
      const bytes = await getEngine().exportQuery(ranSql, format);
      downloadBytes(bytes, `${safeFilename(tabName)}.${format}`, MIME_TYPES[format]!);
      track('result.export');
      toast.success(`Exported as ${format.toUpperCase()}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }

  if (status === 'running') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-ink-muted)]">
        <Loader2 className="size-4 animate-spin" /> Running…
      </div>
    );
  }

  if (status === 'error' && error) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="max-w-2xl rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
            <AlertCircle className="size-4 shrink-0" />
            {error.title}
            {error.position && (
              <span className="font-normal text-[var(--color-ink-muted)]">
                line {error.position.line}, column {error.position.column}
              </span>
            )}
          </p>
          <p className="mt-2 font-mono text-xs whitespace-pre-wrap">{error.detail}</p>
          {error.hint && (
            <p className="mt-2 text-xs text-[var(--color-ink-muted)]">{error.hint}</p>
          )}
          {ranSql && onOpenInEditor && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => onOpenInEditor(ranSql)}
            >
              Put this SQL back in the editor
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (status === 'idle' || !result) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--color-ink-muted)]">
        Write a query and press <Shortcut>⌘/Ctrl</Shortcut> + <Shortcut>Enter</Shortcut> to run it.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-ink-muted)]">
        <span>
          {formatCount(result.rowCount)} row{result.rowCount === 1 ? '' : 's'} ×{' '}
          {result.columns.length} col{result.columns.length === 1 ? '' : 's'}
        </span>
        <span aria-hidden>·</span>
        <span>{formatDuration(result.elapsedMs)}</span>

        {cancelled && (
          <span className="rounded bg-[var(--color-warn)]/15 px-1.5 py-0.5 text-[var(--color-warn)]">
            stopped — partial results
          </span>
        )}
        {result.truncated && !cancelled && (
          <span
            className="rounded bg-[var(--color-warn)]/15 px-1.5 py-0.5 text-[var(--color-warn)]"
            title={`The grid holds at most ${formatCount(MAX_RESULT_ROWS)} rows. Exports and "save as table" still use the whole result.`}
          >
            first {formatCount(MAX_RESULT_ROWS)} rows
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <div
            role="tablist"
            aria-label="Result view"
            className="mr-1 flex items-center gap-0.5 rounded bg-[var(--color-canvas)] p-0.5"
          >
            {(['table', 'chart'] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={view === name}
                onClick={() => {
                  setView(name);
                  // The first visit to the Chart tab picks a chart from the
                  // result's column types, so there's something to react to
                  // rather than an empty encoding panel.
                  if (name === 'chart' && !chart && ranSql) {
                    onChartChange(inferSpec(newId('chart'), ranSql, result.columns));
                  }
                }}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-0.5 capitalize',
                  view === name
                    ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]'
                    : 'hover:text-[var(--color-ink)]',
                )}
              >
                {name === 'chart' ? <BarChart3 className="size-3" /> : <Table2 className="size-3" />}
                {name}
              </button>
            ))}
          </div>

          {view === 'chart' && chart && (
            <>
              <AddToDashboard spec={chart} />
              <ChartExportMenu spec={chart} />
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={<Table2 className="size-3" />}
            onClick={() => setSaving(true)}
            disabled={!ranSql}
          >
            Save as table
          </Button>
          <Menu
            align="right"
            label={
              <span className="flex items-center gap-1">
                {exporting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Download className="size-3" />
                )}
                Export
              </span>
            }
            items={EXPORT_FORMATS.map(({ format, detail }) => ({
              label: format.toUpperCase(),
              detail,
              disabled: !ranSql || exporting !== null,
              onSelect: () => void exportAs(format),
            }))}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {view === 'chart' && chart ? (
          <LazyChartBuilder spec={chart} columns={result.columns} onChange={onChartChange} />
        ) : (
          <ResultsGrid result={result} />
        )}
      </div>

      {saving && ranSql && (
        <SaveAsTableDialog
          sql={ranSql}
          suggestedName={tableNameFromFilename(tabName)}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            void refreshCatalog();
          }}
        />
      )}
    </div>
  );
}

const EXPORT_FORMATS: { format: ExportFormat; detail: string }[] = [
  { format: 'csv', detail: 'spreadsheets' },
  { format: 'json', detail: 'APIs' },
  { format: 'parquet', detail: 'smallest' },
];

function SaveAsTableDialog({
  sql,
  suggestedName,
  onClose,
  onSaved,
}: {
  sql: string;
  suggestedName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await getEngine().createTableAs(name.trim(), sql);
      toast.success(`Created table ${name.trim()}`);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the table');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Save result as a table"
      description="The full query result is materialised, not just the rows on screen."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
            Create table
          </Button>
        </>
      }
    >
      <Field
        label="Table name"
        hint="An existing table with this name will be replaced."
      >
        {({ id, className }) => (
          <input
            id={id}
            className={`${className} font-mono`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <pre className="mt-3 max-h-40 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] whitespace-pre-wrap">
        CREATE OR REPLACE TABLE {name.trim() || '…'} AS{'\n'}
        {sql}
      </pre>
    </Dialog>
  );
}

function Shortcut({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 font-mono text-[10px]">
      {children}
    </kbd>
  );
}
