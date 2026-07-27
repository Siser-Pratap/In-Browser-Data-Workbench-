/**
 * Turning a slice of the grid into text for the clipboard.
 *
 * This is only for *selections* — what the user highlighted, which is bounded
 * by what the grid is showing. Whole-result exports don't come through here at
 * all; they go through `COPY … TO` in the engine, so a million-row export never
 * has to become a JS string.
 */

import type { ColumnSchema } from '@/lib/engine/types';

export function cellText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * RFC 4180 CSV.
 *
 * Quoting is unconditional for any field containing a delimiter, quote or
 * newline — the common failure mode when pasting into a spreadsheet is a value
 * with a comma in it silently becoming two columns.
 */
export function toCsv(columns: ColumnSchema[], rows: unknown[][]): string {
  const header = columns.map((column) => csvField(column.name)).join(',');
  const body = rows.map((row) => row.map((value) => csvField(cellText(value))).join(','));
  return [header, ...body].join('\n');
}

function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A GitHub-flavoured Markdown table, for pasting into a ticket or a PR. */
export function toMarkdown(columns: ColumnSchema[], rows: unknown[][]): string {
  const escape = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = `| ${columns.map((column) => escape(column.name)).join(' | ')} |`;
  // Numbers right-align, so the reader's eye can compare magnitudes down a column.
  const rule = `| ${columns.map((column) => (column.kind === 'number' ? '---:' : ':---')).join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((value) => escape(cellText(value))).join(' | ')} |`);
  return [header, rule, ...body].join('\n');
}

/** Tab-separated — what spreadsheets expect from a plain paste. */
export function toTsv(columns: ColumnSchema[], rows: unknown[][]): string {
  const clean = (text: string) => text.replace(/[\t\n\r]/g, ' ');
  return [
    columns.map((column) => clean(column.name)).join('\t'),
    ...rows.map((row) => row.map((value) => clean(cellText(value))).join('\t')),
  ].join('\n');
}
