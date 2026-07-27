/**
 * Spreadsheet parsing.
 *
 * DuckDB has no spreadsheet reader in the WASM build, so XLSX is the one format
 * that needs a JS parsing pass before it reaches the engine. SheetJS is loaded
 * dynamically so its considerable weight is only paid by users who actually
 * open a spreadsheet.
 */

export interface SheetPreview {
  sheetNames: string[];
  /** The first sheet, which the import dialog offers as the default. */
  defaultSheet: string;
}

export async function readSheetNames(data: Uint8Array): Promise<SheetPreview> {
  const XLSX = await import('xlsx');
  // `bookSheets` skips cell parsing — we only need the sheet list to populate
  // the picker, and workbooks can be large.
  const workbook = XLSX.read(data, { type: 'array', bookSheets: true });
  const sheetNames = workbook.SheetNames ?? [];
  return { sheetNames, defaultSheet: sheetNames[0] ?? '' };
}

/**
 * Parse one sheet into row objects, ready for `importJsonRows`.
 *
 * `defval: null` matters: without it SheetJS omits empty cells entirely, and
 * rows would then disagree about which keys exist — DuckDB's JSON reader would
 * infer a different schema depending on which row it sampled.
 */
export async function readSheetRows(
  data: Uint8Array,
  sheetName?: string,
): Promise<Record<string, unknown>[]> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });

  const name = sheetName ?? workbook.SheetNames[0];
  if (!name) throw new Error('The workbook has no sheets.');

  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`Sheet "${name}" was not found in this workbook.`);

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });

  return rows.map(normalizeRow);
}

/** Dates become ISO strings so DuckDB infers a timestamp rather than an object. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
