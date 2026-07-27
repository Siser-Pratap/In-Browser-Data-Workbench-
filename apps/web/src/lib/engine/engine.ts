import * as duckdb from '@duckdb/duckdb-wasm';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

import { arrowToResult } from './arrow';
import type {
  ColumnSchema,
  DatasetInfo,
  ImportOptions,
  QueryResult,
  SupportedFormat,
} from './types';
import { kindForDuckDbType, quoteIdent, quoteLiteral } from './types';

/**
 * The browser's query engine.
 *
 * DuckDB-WASM runs in a Web Worker — the plan's hard requirement that the UI
 * never freezes depends on it, since a scan over a few hundred megabytes would
 * otherwise block the main thread for seconds. Everything here is therefore
 * async, and the class is a singleton because a second DuckDB instance would
 * double the WASM heap for no benefit.
 *
 * Initialisation is lazy and deduplicated: several components mount at once and
 * all want the engine, but only the first call should actually boot it.
 */
export class DataEngine {
  private db: AsyncDuckDB | null = null;
  private connection: AsyncDuckDBConnection | null = null;
  private worker: Worker | null = null;
  private booting: Promise<void> | null = null;

  /** Which DuckDB bundle the browser actually got, for the status bar. */
  bundleName = '';

  get isReady(): boolean {
    return this.connection !== null;
  }

  /**
   * Boot DuckDB. Safe to call repeatedly and concurrently — the in-flight
   * promise is shared rather than starting a second instance.
   */
  async init(): Promise<void> {
    if (this.connection) return;
    if (this.booting) return this.booting;

    this.booting = this.boot().catch((error) => {
      // Let the next caller retry rather than latching the failure forever.
      this.booting = null;
      throw error;
    });
    return this.booting;
  }

  private async boot(): Promise<void> {
    // Served from our own origin (see scripts/copy-duckdb.mjs): COEP
    // `require-corp` would block a CDN that omits CORP headers.
    const base = `${globalThis.location.origin}/duckdb`;
    const bundles: duckdb.DuckDBBundles = {
      mvp: {
        mainModule: `${base}/duckdb-mvp.wasm`,
        mainWorker: `${base}/duckdb-browser-mvp.worker.js`,
      },
      eh: {
        mainModule: `${base}/duckdb-eh.wasm`,
        mainWorker: `${base}/duckdb-browser-eh.worker.js`,
      },
      coi: {
        mainModule: `${base}/duckdb-coi.wasm`,
        mainWorker: `${base}/duckdb-browser-coi.worker.js`,
        pthreadWorker: `${base}/duckdb-browser-coi.pthread.worker.js`,
      },
    };

    // Choose the bundle deliberately rather than letting `selectBundle` pick
    // the threaded (coi) build.
    //
    // The coi build uses SharedArrayBuffer, but DuckDB's loadable extensions
    // (json — which read_json_auto needs, and which XLSX import also routes
    // through) are compiled against *non-shared* memory. Loading one into the
    // threaded runtime fails with "mismatch in shared state of memory", so JSON
    // and Excel imports break outright. The `eh` build still runs entirely in a
    // Web Worker (the main thread never blocks) and its memory model matches the
    // extensions, so every format works. We give up in-engine threading, which
    // FE1 doesn't need — the large-file story is server-side compute.
    const bundle = bundles.eh!;
    this.bundleName = 'eh';

    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    // The eh bundle has no pthread worker; instantiate without one.
    await db.instantiate(bundle.mainModule, null);

    this.worker = worker;
    this.db = db;
    const connection = await db.connect();
    await preloadExtensions(connection, `${base}/extensions`);
    this.connection = connection;
  }

  private requireConnection(): AsyncDuckDBConnection {
    if (!this.connection) {
      throw new Error('The query engine is not ready yet.');
    }
    return this.connection;
  }

  /** Run SQL and materialise the result for the grid. */
  async query(sql: string): Promise<QueryResult> {
    const connection = this.requireConnection();
    const started = performance.now();
    const table = await connection.query(sql);
    return arrowToResult(table, performance.now() - started);
  }

  /** Run SQL for its effect, discarding any result. */
  async exec(sql: string): Promise<void> {
    await this.requireConnection().query(sql);
  }

  /**
   * Register a file's bytes with DuckDB and create a table from it.
   *
   * The bytes are copied into DuckDB's virtual filesystem and the table is
   * materialised with CREATE TABLE ... AS SELECT, so the buffer can be released
   * afterwards rather than pinned for the session.
   */
  async importFile(
    data: Uint8Array,
    options: ImportOptions,
  ): Promise<Omit<DatasetInfo, 'sourceFilename' | 'importedAt'>> {
    const db = this.db;
    if (!db) throw new Error('The query engine is not ready yet.');

    const virtualName = `${options.table}__source`;
    await db.registerFileBuffer(virtualName, data);

    try {
      const select = readerExpression(virtualName, options);
      await this.exec(
        `CREATE OR REPLACE TABLE ${quoteIdent(options.table)} AS SELECT * FROM ${select}`,
      );
    } finally {
      // Drop the raw bytes whether or not the import worked; on success the
      // table owns its own copy, and on failure nothing should linger.
      await db.dropFile(virtualName).catch(() => undefined);
    }

    const [columns, rowCount] = await Promise.all([
      this.describeTable(options.table),
      this.countRows(options.table),
    ]);

    return { table: options.table, format: options.format, columns, rowCount, byteSize: data.length };
  }

  /** Create a table from already-parsed rows (the XLSX path). */
  async importJsonRows(table: string, rows: Record<string, unknown>[]): Promise<
    Omit<DatasetInfo, 'sourceFilename' | 'importedAt'>
  > {
    const db = this.db;
    if (!db) throw new Error('The query engine is not ready yet.');

    const virtualName = `${table}__source.json`;
    const encoded = new TextEncoder().encode(JSON.stringify(rows));
    await db.registerFileBuffer(virtualName, encoded);

    try {
      await this.exec(
        `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS ` +
          `SELECT * FROM read_json_auto(${quoteLiteral(virtualName)})`,
      );
    } finally {
      await db.dropFile(virtualName).catch(() => undefined);
    }

    const [columns, rowCount] = await Promise.all([
      this.describeTable(table),
      this.countRows(table),
    ]);
    return { table, format: 'xlsx', columns, rowCount, byteSize: encoded.length };
  }

  async describeTable(table: string): Promise<ColumnSchema[]> {
    const result = await this.requireConnection().query(
      `DESCRIBE ${quoteIdent(table)}`,
    );
    const columns: ColumnSchema[] = [];
    for (let i = 0; i < result.numRows; i++) {
      const row = result.get(i);
      if (!row) continue;
      const name = String(row['column_name']);
      const type = String(row['column_type']);
      columns.push({ name, type, kind: kindForDuckDbType(type) });
    }
    return columns;
  }

  async countRows(table: string): Promise<number> {
    const result = await this.requireConnection().query(
      `SELECT count(*)::BIGINT AS n FROM ${quoteIdent(table)}`,
    );
    const row = result.get(0);
    return row ? Number(row['n']) : 0;
  }

  async listTables(): Promise<string[]> {
    const result = await this.requireConnection().query('SHOW TABLES');
    const names: string[] = [];
    for (let i = 0; i < result.numRows; i++) {
      const row = result.get(i);
      if (row) names.push(String(row['name']));
    }
    return names;
  }

  async dropTable(table: string): Promise<void> {
    await this.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
  }

  /**
   * A page of rows for the preview grid.
   *
   * Paging happens in SQL, never in JS — the whole point of DuckDB here is that
   * a million-row table is never materialised on the main thread.
   */
  async preview(
    table: string,
    { limit = 1000, offset = 0, orderBy, descending = false }: PreviewOptions = {},
  ): Promise<QueryResult> {
    const order = orderBy
      ? ` ORDER BY ${quoteIdent(orderBy)} ${descending ? 'DESC' : 'ASC'}`
      : '';
    return this.query(
      `SELECT * FROM ${quoteIdent(table)}${order} LIMIT ${Math.max(1, Math.floor(limit))} ` +
        `OFFSET ${Math.max(0, Math.floor(offset))}`,
    );
  }

  /** Tear everything down — used by "clear workspace" and in tests. */
  async dispose(): Promise<void> {
    await this.connection?.close().catch(() => undefined);
    await this.db?.terminate().catch(() => undefined);
    this.worker?.terminate();
    this.connection = null;
    this.db = null;
    this.worker = null;
    this.booting = null;
  }
}

export interface PreviewOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  descending?: boolean;
}

/**
 * The DuckDB reader call for a registered file.
 *
 * DuckDB parses csv/json/parquet natively, so the file's bytes go straight from
 * the drop zone into the engine without a JS parsing pass.
 */
export function readerExpression(virtualName: string, options: ImportOptions): string {
  const path = quoteLiteral(virtualName);
  switch (options.format) {
    case 'parquet':
      return `read_parquet(${path})`;
    case 'json':
      return `read_json_auto(${path})`;
    case 'csv':
    case 'tsv': {
      const args = [path, 'auto_detect=true'];
      const delimiter = options.delimiter ?? (options.format === 'tsv' ? '\t' : undefined);
      if (delimiter) args.push(`delim=${quoteLiteral(delimiter)}`);
      if (options.hasHeader !== undefined) args.push(`header=${options.hasHeader}`);
      return `read_csv(${args.join(', ')})`;
    }
    case 'xlsx':
      // Handled by importJsonRows: DuckDB-WASM has no spreadsheet reader, so
      // SheetJS parses it first.
      throw new Error('XLSX files are imported via importJsonRows');
    default: {
      const exhaustive: never = options.format;
      throw new Error(`Unsupported format: ${String(exhaustive)}`);
    }
  }
}

/**
 * Extensions to load from our self-hosted mirror before any query runs.
 *
 * `json` backs JSON and Excel import; `parquet` backs Parquet. Both are
 * autoloadable in this DuckDB, and loading them up front from `public/duckdb/
 * extensions` (mirrored by scripts/copy-duckdb.mjs) means an import triggers no
 * autoload and no external fetch. Kept in step with the build script's list.
 */
const PRELOAD_EXTENSIONS = ['json', 'parquet'] as const;

async function preloadExtensions(
  connection: AsyncDuckDBConnection,
  repository: string,
): Promise<void> {
  for (const name of PRELOAD_EXTENSIONS) {
    try {
      // INSTALL ... FROM our origin, then LOAD. If the mirror is missing the
      // file, this throws and we leave the extension unloaded — DuckDB then
      // autoloads it from the default CDN on first use, so a failed mirror
      // degrades to "works, but fetches once" rather than "import hangs". We
      // never override the global repository, precisely to keep that fallback.
      await connection.query(`INSTALL ${name} FROM '${repository}'`);
      await connection.query(`LOAD ${name}`);
    } catch {
      // Left for runtime autoload.
    }
  }
}

let singleton: DataEngine | null = null;

/** The process-wide engine. */
export function getEngine(): DataEngine {
  singleton ??= new DataEngine();
  return singleton;
}

/** Replace the singleton (tests, and "clear workspace"). */
export async function resetEngine(): Promise<void> {
  await singleton?.dispose();
  singleton = null;
}

export type { SupportedFormat };
