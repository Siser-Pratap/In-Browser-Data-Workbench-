'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

import type { Delimiter } from '@/lib/files/csv';
import { decodePreview, sniffCsv } from '@/lib/files/csv';
import { readSheetNames } from '@/lib/files/xlsx';
import type { ImportOptions, SupportedFormat } from '@/lib/engine/types';
import {
  LARGE_FILE_WARNING_BYTES,
  formatFromFilename,
  tableNameFromFilename,
} from '@/lib/engine/types';
import { formatBytes } from '@/lib/utils/format';

interface Props {
  file: File;
  /** Names already taken, so the dialog can warn about a clash. */
  existingTables: string[];
  onCancel: () => void;
  onConfirm: (options: ImportOptions) => void;
  importing: boolean;
}

const DELIMITER_LABELS: Record<Delimiter, string> = {
  ',': 'Comma',
  '\t': 'Tab',
  ';': 'Semicolon',
  '|': 'Pipe',
};

/**
 * Confirm how a file should be read before it's imported.
 *
 * The point is to make the guesses visible: DuckDB's auto-detection is good but
 * not infallible, and finding out it picked the wrong delimiter *after* a large
 * import is a bad experience. Everything shown here is editable.
 */
export function ImportDialog({ file, existingTables, onCancel, onConfirm, importing }: Props) {
  const format = formatFromFilename(file.name) ?? 'csv';
  const [table, setTable] = useState(() => tableNameFromFilename(file.name));
  const [delimiter, setDelimiter] = useState<Delimiter>(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [preview, setPreview] = useState<string[][]>([]);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState('');
  const [inspecting, setInspecting] = useState(true);

  const isCsv = format === 'csv' || format === 'tsv';
  const isExcel = format === 'xlsx';
  const nameClash = existingTables.includes(table);
  const isLarge = file.size > LARGE_FILE_WARNING_BYTES;

  useEffect(() => {
    let cancelled = false;

    async function inspect() {
      setInspecting(true);
      try {
        if (isCsv) {
          // Only the first chunk — enough to sniff, cheap on a huge file.
          const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
          const sniffed = sniffCsv(decodePreview(head));
          if (cancelled) return;
          setDelimiter(sniffed.delimiter);
          setHasHeader(sniffed.hasHeader);
          setPreview(sniffed.preview.slice(0, 6));
        } else if (isExcel) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const { sheetNames, defaultSheet } = await readSheetNames(bytes);
          if (cancelled) return;
          setSheets(sheetNames);
          setSheet(defaultSheet);
        }
      } catch {
        // Preview is a convenience; a failure here shouldn't block the import.
      } finally {
        if (!cancelled) setInspecting(false);
      }
    }

    void inspect();
    return () => {
      cancelled = true;
    };
  }, [file, isCsv, isExcel]);

  function confirm() {
    const options: ImportOptions = { table: table.trim(), format: format as SupportedFormat };
    if (isCsv) {
      options.delimiter = delimiter;
      options.hasHeader = hasHeader;
    }
    if (isExcel && sheet) options.sheet = sheet;
    onConfirm(options);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        className="w-full max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 id="import-title" className="text-sm font-semibold">
            Import {file.name}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            aria-label="Cancel import"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="flex items-center gap-3 text-xs text-[var(--color-ink-muted)]">
            <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 uppercase">
              {format}
            </span>
            <span>{formatBytes(file.size)}</span>
          </div>

          {isLarge && (
            <p className="flex items-start gap-2 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warn)]" />
              <span>
                This file is over {formatBytes(LARGE_FILE_WARNING_BYTES)}. Everything runs in
                your browser tab, so very large files are bounded by available memory — the
                import may be slow or fail. Files this size are a good fit for server-side
                compute once you have an account.
              </span>
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium">Table name</span>
            <input
              value={table}
              onChange={(event) => setTable(event.target.value)}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-sm"
            />
            {nameClash && (
              <span className="mt-1 block text-xs text-[var(--color-warn)]">
                A dataset named “{table}” already exists — importing will replace it.
              </span>
            )}
          </label>

          {isCsv && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Delimiter</span>
                <select
                  value={delimiter}
                  onChange={(event) => setDelimiter(event.target.value as Delimiter)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                >
                  {Object.entries(DELIMITER_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(event) => setHasHeader(event.target.checked)}
                />
                First row is a header
              </label>
            </div>
          )}

          {isExcel && sheets.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Sheet</span>
              <select
                value={sheet}
                onChange={(event) => setSheet(event.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
              >
                {sheets.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {inspecting ? (
            <p className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
              <Loader2 className="size-3 animate-spin" /> Inspecting file…
            </p>
          ) : (
            preview.length > 0 && (
              <div>
                <span className="mb-1 block text-xs font-medium">Preview</span>
                <div className="overflow-x-auto rounded border border-[var(--color-border)]">
                  <table className="w-full font-mono text-[11px]">
                    <tbody>
                      {preview.map((row, rowIndex) => (
                        <tr
                          key={rowIndex}
                          className={
                            hasHeader && rowIndex === 0
                              ? 'bg-[var(--color-surface)] font-semibold'
                              : ''
                          }
                        >
                          {row.map((cell, cellIndex) => (
                            <td
                              key={cellIndex}
                              className="max-w-40 truncate border-r border-[var(--color-border)] px-2 py-1 last:border-r-0"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={importing}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={importing || table.trim() === ''}
            className="flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-ink)] hover:opacity-90 disabled:opacity-50"
          >
            {importing && <Loader2 className="size-3.5 animate-spin" />}
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
