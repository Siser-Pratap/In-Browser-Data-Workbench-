import { Type, type DataType, type Table } from 'apache-arrow';

import type { ColumnSchema, QueryResult } from './types';
import { kindForDuckDbType } from './types';

/**
 * Convert an Arrow table into plain rows for the grid.
 *
 * Arrow is how DuckDB hands results back and it's why results are cheap to
 * move, but React can't render an Arrow vector. This is the one place the
 * zero-copy representation is materialised, so it's the one place that pays —
 * hence the caller always applies a LIMIT first.
 */
export function arrowToResult(table: Table, elapsedMs: number): QueryResult {
  const fields = table.schema.fields;
  const columns: ColumnSchema[] = fields.map((field) => {
    const type = String(field.type);
    return { name: field.name, type, kind: kindForDuckDbType(type) };
  });

  // Temporal columns arrive as plain numbers, so the *field type* decides how
  // to read them — the value alone can't tell you whether 19000 is a day count
  // or a quantity.
  const converters = fields.map((field) => converterFor(field.type));

  const rows: unknown[][] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row = table.get(i);
    if (!row) continue;
    rows.push(
      columns.map((column, index) => {
        const convert = converters[index] ?? normalizeValue;
        return convert(row[column.name]);
      }),
    );
  }

  return { columns, rows, rowCount: table.numRows, elapsedMs };
}

type Converter = (value: unknown) => unknown;

/**
 * How to render one Arrow temporal type.
 *
 * DuckDB-WASM's Arrow row proxy already normalises Date and Timestamp columns
 * to **epoch-milliseconds** before handing them out — a `Date32<DAY>` value
 * comes back as `1783641600000`, not a day count. Verified with a probe against
 * a real import; an earlier version re-scaled by the storage unit and produced
 * "Invalid date". So there's no unit arithmetic here: turn the millisecond
 * number into a readable string, and leave `Time` (time-of-day, no date) to
 * `normalizeValue`.
 */
function converterFor(type: DataType): Converter {
  switch (type.typeId) {
    case Type.Date:
      return (value) => {
        const epochMs = toEpochNumber(value);
        return epochMs === null ? normalizeValue(value) : isoDate(new Date(epochMs));
      };

    case Type.Timestamp:
      return (value) => {
        const epochMs = toEpochNumber(value);
        return epochMs === null ? normalizeValue(value) : isoDateTime(new Date(epochMs));
      };

    default:
      return normalizeValue;
  }
}

function toEpochNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  return null;
}

function isoDate(date: Date): string {
  return Number.isNaN(date.getTime()) ? 'Invalid date' : date.toISOString().slice(0, 10);
}

function isoDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  // Drop the trailing `Z`/millis noise: these are wall-clock values from the
  // user's file, not instants in a timezone we know anything about.
  return date.toISOString().slice(0, 23).replace('T', ' ').replace(/\.000$/, '');
}

/**
 * Make an Arrow value renderable and structured-cloneable.
 *
 * Values cross a worker boundary via postMessage, so anything that isn't
 * cloneable has to be flattened here rather than at the render site: BigInt
 * clones but breaks `JSON.stringify` and React's text rendering, and Arrow's
 * nested vectors don't survive the trip at all.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === 'bigint') {
    // Beyond 2^53 a JS number is no longer exact; keep those as text so the
    // grid shows the true value instead of a silently rounded one.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }

  if (value instanceof Date) return isoDateTime(value);

  if (ArrayBuffer.isView(value)) {
    return `[${(value as unknown as ArrayLike<number>).length} bytes]`;
  }

  if (typeof value === 'object') {
    // Structs, lists and maps: show them as JSON rather than "[object Object]".
    try {
      return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      return String(value);
    }
  }

  return value;
}
