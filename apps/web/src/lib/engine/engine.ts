import type * as duckdb from '@duckdb/duckdb-wasm';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { RecordBatch } from 'apache-arrow';

import { arrowToResult, batchesToResult } from './arrow';
import type {
  CatalogTable,
  ColumnSchema,
  ColumnStats,
  DatasetInfo,
  ExportFormat,
  ImportOptions,
  QueryResult,
  SupportedFormat,
} from './types';
import { kindForDuckDbType, quoteIdent, quoteLiteral } from './types';

/**
 * How many rows a user-written query may materialise into the grid.
 *
 * The grid is virtualised, so the limit isn't about DOM size — it's about the
 * JS array. A `SELECT *` over a 50M-row table would otherwise try to build 50M
 * arrays on the main thread and take the tab down with it. Results above this
 * are marked `truncated` so the UI can say so honestly.
 */
export const MAX_RESULT_ROWS = 50_000;

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
  /** The connection with a streamed query in flight, if any — see `cancel`. */
  private streaming: AsyncDuckDBConnection | null = null;

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
    // Imported here rather than at module scope so DuckDB's driver stays out of
    // the initial bundle. It's still fetched immediately — the app boots the
    // engine on load — but as a parallel chunk rather than as bytes the browser
    // must parse before the first paint.
    const duckdb = await import('@duckdb/duckdb-wasm');

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
   * Run a user-written statement, streaming and cancellably.
   *
   * `query()` is fine for the queries *we* write, which are always bounded. A
   * query the user typed is not: it can scan forever, and the only way to stop
   * it is DuckDB's pending-query cancellation, which is only available for
   * statements started with `send()`. So user SQL takes this path — the batches
   * arrive incrementally, the row cap can stop the read early, and `cancel()`
   * can abort it mid-scan.
   */
  async runQuery(sql: string, maxRows = MAX_RESULT_ROWS): Promise<QueryResult> {
    const connection = this.requireConnection();
    const started = performance.now();

    const reader = await connection.send(sql);
    this.streaming = connection;
    const batches: RecordBatch[] = [];
    let rows = 0;
    try {
      // `send` hands back a reader that has not read its schema message yet, so
      // `reader.schema` is undefined until it's opened. Guarded rather than
      // unconditional because opening twice would consume a message.
      if (!reader.schema) await reader.open();

      for await (const batch of reader) {
        batches.push(batch);
        rows += batch.numRows;
        if (rows >= maxRows) {
          // Stop pulling, and tell DuckDB to stop producing — otherwise the
          // rest of the scan runs to completion for results nobody will read.
          await connection.cancelSent().catch(() => undefined);
          break;
        }
      }
    } finally {
      this.streaming = null;
    }

    const elapsedMs = performance.now() - started;
    // A statement with no result at all (DDL, or a cancellation that landed
    // before the schema did) has no columns to describe.
    const schema = reader.schema ?? batches[0]?.schema;
    if (!schema) return { columns: [], rows: [], rowCount: 0, elapsedMs };

    return batchesToResult(schema, batches, elapsedMs, maxRows);
  }

  /**
   * Ask DuckDB to abandon the in-flight streamed query.
   *
   * Returns false when there was nothing to cancel. The awaiting `runQuery`
   * still resolves — with however many batches arrived — rather than rejecting,
   * because a cancelled query has produced a real (partial) answer, and the
   * caller decides whether to show it.
   */
  async cancel(): Promise<boolean> {
    const connection = this.streaming;
    if (!connection) return false;
    return connection.cancelSent().catch(() => false);
  }

  get isQueryRunning(): boolean {
    return this.streaming !== null;
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

  /**
   * Every table and column DuckDB currently knows about.
   *
   * Read from `information_schema` rather than cached from import, so a table
   * created by the user's own `CREATE TABLE` shows up in autocomplete with no
   * extra bookkeeping — the catalogue is the single source of truth and can't
   * drift.
   */
  async catalog(): Promise<CatalogTable[]> {
    const result = await this.requireConnection().query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY table_name, ordinal_position`,
    );

    const byTable = new Map<string, ColumnSchema[]>();
    for (let i = 0; i < result.numRows; i++) {
      const row = result.get(i);
      if (!row) continue;
      const table = String(row['table_name']);
      const type = String(row['data_type']);
      const columns = byTable.get(table) ?? [];
      columns.push({ name: String(row['column_name']), type, kind: kindForDuckDbType(type) });
      byTable.set(table, columns);
    }
    return [...byTable].map(([name, columns]) => ({ name, columns }));
  }

  /**
   * Profile one column: nulls, cardinality, range, most common values.
   *
   * `approx_count_distinct` rather than `count(DISTINCT …)` — the popover opens
   * on hover, so it has to be cheap on a large table, and a HyperLogLog estimate
   * is the right accuracy for "roughly how many categories is this?".
   * min/max are cast to VARCHAR because a struct or list column has no orderable
   * min; those simply come back null instead of failing the whole profile.
   */
  async columnStats(table: string, column: string): Promise<ColumnStats> {
    const identifier = quoteIdent(column);
    const source = quoteIdent(table);

    const summary = await this.requireConnection().query(
      `SELECT count(*)::BIGINT AS total,
              count(${identifier})::BIGINT AS non_null,
              approx_count_distinct(${identifier})::BIGINT AS distinct_count
       FROM ${source}`,
    );
    const summaryRow = summary.get(0);
    const rowCount = summaryRow ? Number(summaryRow['total']) : 0;
    const nonNull = summaryRow ? Number(summaryRow['non_null']) : 0;

    let min: string | null = null;
    let max: string | null = null;
    try {
      const range = await this.requireConnection().query(
        `SELECT min(${identifier})::VARCHAR AS lo, max(${identifier})::VARCHAR AS hi FROM ${source}`,
      );
      const rangeRow = range.get(0);
      min = rangeRow?.['lo'] == null ? null : String(rangeRow['lo']);
      max = rangeRow?.['hi'] == null ? null : String(rangeRow['hi']);
    } catch {
      // Unorderable type (struct, list, map); the rest of the profile stands.
    }

    const topValues: ColumnStats['topValues'] = [];
    try {
      const top = await this.requireConnection().query(
        `SELECT ${identifier}::VARCHAR AS value, count(*)::BIGINT AS n
         FROM ${source} WHERE ${identifier} IS NOT NULL
         GROUP BY 1 ORDER BY n DESC, 1 LIMIT 5`,
      );
      for (let i = 0; i < top.numRows; i++) {
        const row = top.get(i);
        if (!row) continue;
        topValues.push({
          value: row['value'] == null ? null : String(row['value']),
          count: Number(row['n']),
        });
      }
    } catch {
      // Uncastable type; leave the list empty.
    }

    return {
      column,
      rowCount,
      nullCount: rowCount - nonNull,
      distinctCount: summaryRow ? Number(summaryRow['distinct_count']) : 0,
      min,
      max,
      topValues,
    };
  }

  /** Materialise a query as a new table. */
  async createTableAs(table: string, sql: string): Promise<void> {
    await this.exec(`CREATE OR REPLACE TABLE ${quoteIdent(table)} AS ${sql}`);
  }

  async renameTable(from: string, to: string): Promise<void> {
    await this.exec(`ALTER TABLE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`);
  }

  /**
   * Serialise a query's full result to a downloadable file.
   *
   * DuckDB writes the file itself (`COPY … TO`) into its virtual filesystem and
   * we copy the bytes out. That matters for the plan's "export a 1M-row result"
   * criterion: the rows never pass through JS, so the export isn't bounded by
   * `MAX_RESULT_ROWS` or by what the grid happens to be showing.
   */
  async exportQuery(sql: string, format: ExportFormat): Promise<Uint8Array> {
    const db = this.db;
    if (!db) throw new Error('The query engine is not ready yet.');

    const virtualName = `export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${format}`;
    await db.registerEmptyFileBuffer(virtualName);
    try {
      await this.exec(
        `COPY (${stripTrailingSemicolon(sql)}) TO ${quoteLiteral(virtualName)} ${COPY_OPTIONS[format]}`,
      );
      return await db.copyFileToBuffer(virtualName);
    } finally {
      await db.dropFile(virtualName).catch(() => undefined);
    }
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
    this.streaming = null;
  }
}

const COPY_OPTIONS: Record<ExportFormat, string> = {
  csv: '(FORMAT CSV, HEADER true)',
  json: '(FORMAT JSON, ARRAY true)',
  parquet: '(FORMAT PARQUET, COMPRESSION zstd)',
};

/** `COPY (…) TO` wraps the query in parens, where a trailing `;` is a syntax error. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
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
