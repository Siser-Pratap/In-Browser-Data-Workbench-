/**
 * Executing the analyst's tool calls, in the browser, against DuckDB-WASM.
 *
 * The backend runs the model loop and decides *what* to do; this module does
 * it. That split is what lets the agent run a dozen queries to answer a
 * question without the tables ever leaving the machine — only the results it
 * reads back cross the wire, which is the thing the consent gate is about.
 *
 * Three rules govern everything here, and all three are silent failures if
 * broken:
 *
 * 1. **Every pending call must produce a result.** The server matches the
 *    returned `tool_use_id` set against what it is waiting for and rejects a
 *    mismatch outright (`NotAwaitingToolsError`), so a tool that throws still
 *    has to come back — as an error result, not an exception.
 * 2. **Failures are data, not exceptions.** `is_error: true` with the message
 *    is how the model learns its SQL was wrong and fixes it. Swallowing the
 *    error costs a turn; throwing it kills the conversation.
 * 3. **Results are budgeted here, not by the server.** The server truncates
 *    tool output at a fixed character count with no idea what it is cutting,
 *    and JSON severed mid-token is worse than no data. So each tool returns a
 *    deliberately compact shape, and `budget()` is the last resort.
 */

import { getEngine } from '@/lib/engine/engine';
import type { ClientToolResult } from '@/lib/api/types';
import type { ToolCallEvent } from '@/lib/api/ai';
import { buildTableProfile } from '@/lib/ai/profile';

/**
 * Rows returned to the model per query.
 *
 * Small on purpose. The model is answering a question, not rendering a table —
 * it needs enough rows to see the shape and the extremes, and the prompt tells
 * it to aggregate rather than scan. The true row count travels alongside, so a
 * capped result is never mistaken for the whole answer.
 */
export const MAX_TOOL_ROWS = 50;

/** Hard ceiling on one serialised result. The server's own cap is 20 000. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

export interface ToolContext {
  /** Called when a tool materialises or changes tables, so the UI can refresh. */
  onCatalogChanged?: () => void;
  /** Called when the agent produces a chart, so the panel can render it. */
  onChart?: (spec: Record<string, unknown>) => void;
  /** Called when the agent saves a query. */
  onSaveQuery?: (name: string, sql: string) => Promise<void> | void;
}

/**
 * Run every pending call and return one result each, in order.
 *
 * Sequential rather than parallel: they all contend for a single DuckDB
 * connection, so `Promise.all` would buy nothing but a less predictable order
 * of side effects (a `CREATE TABLE` racing the `SELECT` that reads it).
 */
export async function executeToolCalls(
  calls: ToolCallEvent[],
  context: ToolContext = {},
): Promise<ClientToolResult[]> {
  const results: ClientToolResult[] = [];
  for (const call of calls) {
    results.push(await executeToolCall(call, context));
  }
  return results;
}

export async function executeToolCall(
  call: ToolCallEvent,
  context: ToolContext = {},
): Promise<ClientToolResult> {
  try {
    const content = await dispatch(call, context);
    return { tool_use_id: call.tool_use_id, content: budget(content), is_error: false };
  } catch (error) {
    return {
      tool_use_id: call.tool_use_id,
      content: error instanceof Error ? error.message : 'The tool failed.',
      is_error: true,
    };
  }
}

async function dispatch(call: ToolCallEvent, context: ToolContext): Promise<unknown> {
  const engine = getEngine();
  const input = call.input ?? {};

  switch (call.name) {
    case 'list_tables': {
      const catalog = await engine.catalog();
      return {
        tables: catalog.map((table) => ({
          name: table.name,
          columns: table.columns.length,
        })),
      };
    }

    case 'get_schema': {
      const table = requireString(input, 'table');
      const columns = await engine.describeTable(table);
      return {
        table,
        row_count: await engine.countRows(table),
        columns: columns.map((column) => ({ name: column.name, type: column.type })),
      };
    }

    case 'get_profile':
      return buildTableProfile(requireString(input, 'table'));

    case 'run_sql': {
      const sql = requireString(input, 'sql');
      // The server already validated this is a single read-only statement (or a
      // CREATE TABLE ... AS), so no second guard here — just execution.
      const result = await engine.runQuery(sql, MAX_TOOL_ROWS);

      // A CTAS returns no columns; report the new table rather than "0 rows",
      // which reads to the model as an empty result and prompts a retry.
      if (result.columns.length === 0) {
        context.onCatalogChanged?.();
        return { ok: true, note: 'Statement executed. Any table it created now exists.' };
      }

      return {
        columns: result.columns.map((column) => column.name),
        rows: result.rows.map((row) => row.map(cellForModel)),
        returned_rows: result.rows.length,
        truncated: Boolean(result.truncated) || result.rows.length >= MAX_TOOL_ROWS,
        note:
          result.truncated || result.rows.length >= MAX_TOOL_ROWS
            ? `Only the first ${MAX_TOOL_ROWS} rows are shown. Aggregate in SQL for a complete answer.`
            : undefined,
      };
    }

    case 'create_chart': {
      // The spec was validated server-side before dispatch; rendering is the
      // panel's job, so this only hands it over and acknowledges.
      context.onChart?.(input as Record<string, unknown>);
      return { ok: true, note: 'Chart rendered for the user.' };
    }

    case 'save_query': {
      const name = requireString(input, 'name');
      const sql = requireString(input, 'sql');
      await context.onSaveQuery?.(name, sql);
      return { ok: true, note: `Saved as “${name}”.` };
    }

    default:
      // Reported as an error result so the model can pick a different tool
      // rather than the turn dying on an unknown name.
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

/**
 * Make one cell safe to serialise.
 *
 * DuckDB hands back BigInt for 64-bit integers and typed objects for dates and
 * structs; `JSON.stringify` throws outright on the first and produces `{}` for
 * the second. Either way the tool result would be lost, so everything that
 * isn't a plain JSON scalar becomes a string.
 */
export function cellForModel(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Last-resort size guard.
 *
 * Every tool above already returns a bounded shape, so this should not normally
 * fire — it exists for the case a single cell is enormous (a long text column,
 * an embedded blob). Replacing the payload with an explicit message is better
 * than letting the server cut the JSON somewhere arbitrary: the model can act
 * on "too large, aggregate instead" and cannot act on a syntax error.
 */
export function budget(content: unknown): unknown {
  let serialised: string;
  try {
    serialised = JSON.stringify(content) ?? '';
  } catch {
    return { error: 'The result could not be serialised.' };
  }
  if (serialised.length <= MAX_TOOL_RESULT_CHARS) return content;
  return {
    error: 'Result too large to return.',
    note: `The result serialised to ${serialised.length} characters, over the ${MAX_TOOL_RESULT_CHARS} limit. Aggregate, select fewer columns, or add a LIMIT.`,
  };
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value;
}
