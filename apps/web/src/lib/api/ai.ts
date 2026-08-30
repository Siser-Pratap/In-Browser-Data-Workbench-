/**
 * The AI endpoints.
 *
 * Every one of them streams, and every one of them returns a *proposal*. There
 * is deliberately no function here that runs anything: `generateSql` yields SQL
 * and stops. Whether it executes is a separate, explicit user action, which is
 * both the product's trust model and the reason the browser stays the only
 * place the user's rows are ever touched.
 *
 * The event shapes mirror the server's own contract, documented at the top of
 * `apps/api/src/app/ai/service.py` and `chat_service.py`.
 */

import { stream } from './client';
import { readSse, type SseEvent } from './sse';
import type {
  ChatCreateResponse,
  ClientToolResult,
  TableProfile,
  TableSchemaPayload,
} from './types';
import { request } from './client';
import type { CatalogTable } from '@/lib/engine/types';

/**
 * The catalogue, as the AI endpoints want it.
 *
 * `catalog()` already produces exactly this information — the mapping is a
 * rename, not a computation, which is why the schema payload needs no separate
 * collection pass over the engine.
 */
export function toTableSchemas(tables: CatalogTable[]): TableSchemaPayload[] {
  return tables.map((table) => ({
    name: table.name,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
  }));
}

// -- event types ------------------------------------------------------------

export interface DeltaEvent extends SseEvent {
  type: 'delta';
  text: string;
}
export interface SqlEvent extends SseEvent {
  type: 'sql';
  sql: string;
  explanation: string | null;
  corrected: boolean;
}
export interface ClarificationEvent extends SseEvent {
  type: 'clarification';
  question: string;
}
export interface ExplanationEvent extends SseEvent {
  type: 'explanation';
  text: string;
}
export interface ErrorEvent extends SseEvent {
  type: 'error';
  code: string;
  message: string;
}
export interface DoneEvent extends SseEvent {
  type: 'done';
  usage?: { input_tokens: number; output_tokens: number };
}

export type SqlStreamEvent =
  | DeltaEvent
  | SqlEvent
  | ClarificationEvent
  | ExplanationEvent
  | ErrorEvent
  | DoneEvent;

// -- Phase 1: SQL -----------------------------------------------------------

export async function* generateSql(
  question: string,
  tables: CatalogTable[],
  signal?: AbortSignal,
): AsyncGenerator<SqlStreamEvent> {
  const response = await stream('/ai/sql', {
    body: { question, tables: toTableSchemas(tables), dialect: 'duckdb' },
    signal,
  });
  yield* readSse(response) as AsyncGenerator<SqlStreamEvent>;
}

/** Repair a failing query. `error` is DuckDB's own message, not a paraphrase. */
export async function* fixSql(
  sql: string,
  error: string,
  tables: CatalogTable[],
  signal?: AbortSignal,
): AsyncGenerator<SqlStreamEvent> {
  const response = await stream('/ai/sql/fix', {
    body: { sql, error, tables: toTableSchemas(tables), dialect: 'duckdb' },
    signal,
  });
  yield* readSse(response) as AsyncGenerator<SqlStreamEvent>;
}

export async function* explainSql(
  sql: string,
  tables: CatalogTable[],
  signal?: AbortSignal,
): AsyncGenerator<SqlStreamEvent> {
  const response = await stream('/ai/sql/explain', {
    body: { sql, tables: toTableSchemas(tables), dialect: 'duckdb' },
    signal,
  });
  yield* readSse(response) as AsyncGenerator<SqlStreamEvent>;
}

// -- Phase 2: insights ------------------------------------------------------

export interface Insight {
  title: string;
  detail: string;
  verification_sql: string;
  severity?: string;
  [key: string]: unknown;
}

export interface InsightsEvent extends SseEvent {
  type: 'insights';
  insights: Insight[];
  dropped: number;
}

export async function* generateInsights(
  profile: TableProfile,
  focus: string | null,
  signal?: AbortSignal,
): AsyncGenerator<InsightsEvent | ErrorEvent | DoneEvent | DeltaEvent> {
  const response = await stream('/ai/insights', {
    body: { profile, ...(focus ? { focus } : {}) },
    signal,
  });
  yield* readSse(response) as AsyncGenerator<InsightsEvent | ErrorEvent | DoneEvent | DeltaEvent>;
}

// -- Phase 3: analyst chat --------------------------------------------------

/**
 * A tool the browser must run.
 *
 * The id field is `tool_use_id`, not `id` — it has to be echoed back verbatim
 * in the `ClientToolResult`, and the server rejects the whole submission if the
 * returned set doesn't match what it is waiting for.
 */
export interface ToolCallEvent extends SseEvent {
  type: 'tool_call';
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
}
/** One step's finished assistant text (`chat_service.py` sends `text`). */
export interface MessageEvent extends SseEvent {
  type: 'message';
  text: string;
}
export interface AwaitingToolsEvent extends SseEvent {
  type: 'awaiting_tools';
}

export type ChatStreamEvent =
  | DeltaEvent
  | MessageEvent
  | ToolCallEvent
  | AwaitingToolsEvent
  | ErrorEvent
  | DoneEvent;

export async function createChatSession(
  tables: CatalogTable[],
  title?: string,
): Promise<ChatCreateResponse> {
  return request<ChatCreateResponse>('/ai/chat', {
    method: 'POST',
    body: { tables: toTableSchemas(tables), ...(title ? { title } : {}) },
  });
}

export async function* sendChatMessage(
  sessionId: string,
  content: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await stream(`/ai/chat/${sessionId}/message`, { body: { content }, signal });
  yield* readSse(response) as AsyncGenerator<ChatStreamEvent>;
}

/** Hand back browser-executed tool results to resume a paused turn. */
export async function* submitToolResults(
  sessionId: string,
  results: ClientToolResult[],
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await stream(`/ai/chat/${sessionId}/tool-result`, {
    body: { results },
    signal,
  });
  yield* readSse(response) as AsyncGenerator<ChatStreamEvent>;
}
