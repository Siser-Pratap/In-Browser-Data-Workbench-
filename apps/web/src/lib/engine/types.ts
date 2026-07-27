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
  /** True when the row cap stopped the read before the result was exhausted. */
  truncated?: boolean;
}

/** Lazily-computed profile of one column, for the schema explorer popover. */
export interface ColumnStats {
  column: string;
  rowCount: number;
  nullCount: number;
  distinctCount: number;
  min: string | null;
  max: string | null;
  topValues: { value: string | null; count: number }[];
}

/** The engine's catalogue, flattened for autocomplete. */
export interface CatalogTable {
  name: string;
  columns: ColumnSchema[];
}

/** Formats `COPY … TO` can write. */
export type ExportFormat = 'csv' | 'json' | 'parquet';

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

/**
 * Collapse a column type to the kind the UI reasons about.
 *
 * This has to understand **two spellings of the same types**. `DESCRIBE` gives
 * DuckDB's names (`VARCHAR`, `BIGINT`, `TIMESTAMP`), while a query result is
 * read out of Arrow, which calls the same things `Utf8`, `Int64` and
 * `Timestamp<MICROSECOND>`. Getting that wrong is not cosmetic: the chart
 * builder infers a chart from these kinds, so a text column read as `other`
 * silently stops being a category anyone can group by.
 *
 * Order matters here, because these names nest inside each other:
 * `INTERVAL` contains `INT`, `STRUCT(a VARCHAR)` contains `VARCHAR`, and
 * Arrow spells an enum `Dictionary<Int8, Utf8>` — where the *indices* are an
 * integer type and the values are the ones that matter.
 */
export function kindForDuckDbType(type: string): ColumnKind {
  const t = type.toUpperCase().trim();

  // Composites first: their parameters name other types.
  if (/^(LIST|LARGELIST|FIXEDSIZELIST|STRUCT|MAP|UNION)\s*[<(]/.test(t) || t.endsWith('[]')) {
    return 'other';
  }

  const dictionary = /^DICTIONARY\s*<[^,]+,\s*(.+)>$/.exec(t);
  if (dictionary) return kindForDuckDbType(dictionary[1]!);

  // Temporal before numeric, so INTERVAL isn't caught by the `INT` in its name.
  if (/(DATE|TIME|TIMESTAMP|INTERVAL|DURATION)/.test(t)) return 'date';
  if (/BOOL/.test(t)) return 'boolean';
  if (/(VARCHAR|CHAR|TEXT|STRING|UUID|ENUM|UTF8)/.test(t)) return 'string';
  if (/(INT|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT)/.test(t)) return 'number';
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
