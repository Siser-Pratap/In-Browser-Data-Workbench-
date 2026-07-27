/** Shared vocabulary between the engine, the stores and the UI. */

export type EngineStatus = 'idle' | 'initializing' | 'ready' | 'error';

/** The file formats the workbench can ingest. */
export type SupportedFormat = 'csv' | 'tsv' | 'json' | 'parquet' | 'xlsx';

/** A column as DuckDB describes it, plus the coarse kind the UI renders. */
export interface ColumnSchema {
  name: string;
  /** The DuckDB type, verbatim — e.g. `BIGINT`, `VARCHAR`, `TIMESTAMP`. */
  type: string;
  kind: ColumnKind;
}

/**
 * Types collapse to five kinds for display. The grid only needs to choose an
 * icon and an alignment; it should not care that `HUGEINT` and `SMALLINT` differ.
 */
export type ColumnKind = 'number' | 'string' | 'date' | 'boolean' | 'other';

export interface DatasetInfo {
  /** The DuckDB table name; unique within a session. */
  table: string;
  /** The file this came from, for display. */
  sourceFilename: string;
  format: SupportedFormat;
  rowCount: number;
  columns: ColumnSchema[];
  byteSize: number;
  importedAt: number;
}

export interface QueryResult {
  columns: ColumnSchema[];
  /** Row-major, already converted out of Arrow for the grid. */
  rows: unknown[][];
  rowCount: number;
  /** Milliseconds spent inside DuckDB. */
  elapsedMs: number;
}

export interface ImportOptions {
  table: string;
  format: SupportedFormat;
  /** CSV/TSV only. */
  delimiter?: string;
  hasHeader?: boolean;
  /** XLSX only: which sheet to import. */
  sheet?: string;
}

/** Guardrail from the plan: warn above this, don't block. */
export const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;

const EXTENSION_FORMATS: Record<string, SupportedFormat> = {
  csv: 'csv',
  tsv: 'tsv',
  txt: 'csv',
  json: 'json',
  ndjson: 'json',
  parquet: 'parquet',
  pq: 'parquet',
  xlsx: 'xlsx',
  xls: 'xlsx',
};

export function formatFromFilename(filename: string): SupportedFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return EXTENSION_FORMATS[ext] ?? null;
}

/**
 * A DuckDB table name derived from a filename.
 *
 * Identifiers are quoted everywhere they're interpolated, but a name is also
 * something the user types into SQL by hand — so keep it to the characters
 * that don't need quoting, and never let it start with a digit.
 */
export function tableNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!cleaned) return 'dataset';
  return /^\d/.test(cleaned) ? `t_${cleaned}` : cleaned;
}

export function kindForDuckDbType(type: string): ColumnKind {
  const t = type.toUpperCase();
  if (/(INT|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|HUGEINT)/.test(t)) return 'number';
  if (/BOOL/.test(t)) return 'boolean';
  if (/(DATE|TIME|TIMESTAMP|INTERVAL)/.test(t)) return 'date';
  if (/(VARCHAR|CHAR|TEXT|STRING|UUID|ENUM)/.test(t)) return 'string';
  return 'other';
}

/**
 * Quote an identifier for interpolation into SQL.
 *
 * Table and column names reach SQL from filenames and from DuckDB's own
 * catalog, and DuckDB's JS API has no bound-parameter support for identifiers —
 * so this is the only thing standing between a file called `foo"; DROP …` and
 * a broken (or hostile) statement. Doubling embedded quotes is the SQL-standard
 * escape.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal for interpolation into SQL. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
