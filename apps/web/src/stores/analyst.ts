'use client';

import { create } from 'zustand';

import {
  createChatSession,
  sendChatMessage,
  submitToolResults,
  type ChatStreamEvent,
  type ToolCallEvent,
} from '@/lib/api/ai';
import type { ClientToolResult } from '@/lib/api/types';
import { executeToolCalls, type ToolContext } from '@/lib/ai/tools';
import { track } from '@/lib/telemetry/telemetry';
import { newId } from '@/lib/utils/id';
import { useCatalogStore } from '@/stores/catalog';
import { useHistoryStore } from '@/stores/history';

/**
 * The conversational analyst.
 *
 * The backend owns the model loop; this owns the half of it that runs here. A
 * turn is not one request — it is a cycle:
 *
 *   send message → stream → `awaiting_tools` → run the tools against DuckDB →
 *   POST the results → stream continues → … → `done`
 *
 * so the transport is a loop, not a single call, and `runTurn` below is that
 * loop. It is bounded by the server (turn caps, per-turn tool-call caps, a
 * session token budget, and a forced tools-off wrap-up), which is why there is
 * no client-side iteration limit duplicating the same policy badly.
 *
 * The transcript is UI state and deliberately not the model's context: the
 * server holds the real message history for the session. Rebuilding it here
 * would be a second source of truth that could disagree.
 */

export type TranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | {
      id: string;
      kind: 'tool';
      name: string;
      input: Record<string, unknown>;
      status: 'running' | 'ok' | 'error';
      detail?: string;
    }
  | { id: string; kind: 'chart'; spec: Record<string, unknown> }
  | { id: string; kind: 'error'; text: string };

export type AnalystStatus = 'idle' | 'thinking' | 'running-tools';

interface AnalystState {
  sessionId: string | null;
  starters: string[];
  transcript: TranscriptItem[];
  status: AnalystStatus;
  /** Streaming assistant text for the step in flight, shown as it arrives. */
  pendingText: string;

  ask: (question: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

let abort: AbortController | null = null;

export const useAnalystStore = create<AnalystState>()((set, get) => ({
  sessionId: null,
  starters: [],
  transcript: [],
  status: 'idle',
  pendingText: '',

  ask: async (question) => {
    const trimmed = question.trim();
    if (!trimmed || get().status !== 'idle') return;

    abort = new AbortController();
    const signal = abort.signal;

    push({ id: newId('m'), kind: 'user', text: trimmed });
    set({ status: 'thinking', pendingText: '' });
    track('ai.analyst.ask');

    try {
      // One session per conversation, opened lazily so the panel can be shown
      // (and its starters offered) without spending anything.
      let sessionId = get().sessionId;
      if (!sessionId) {
        const tables = useCatalogStore.getState().tables;
        const created = await createChatSession(tables);
        sessionId = created.session_id;
        set({ sessionId, starters: created.starter_prompts ?? [] });
      }

      await runTurn(() => sendChatMessage(sessionId!, trimmed, signal), sessionId, signal);
    } catch (error) {
      if (!isAbort(error)) {
        push({ id: newId('m'), kind: 'error', text: messageOf(error) });
      }
    } finally {
      set({ status: 'idle', pendingText: '' });
      abort = null;
    }
  },

  stop: () => {
    abort?.abort();
    abort = null;
    set({ status: 'idle', pendingText: '' });
  },

  reset: () => {
    abort?.abort();
    abort = null;
    set({ sessionId: null, starters: [], transcript: [], status: 'idle', pendingText: '' });
  },
}));

/**
 * Consume one stream, then keep going for as long as the server asks for tools.
 *
 * `start` is a thunk because the first leg is `sendChatMessage` and every
 * subsequent leg is `submitToolResults` — same consumer, different opener.
 */
async function runTurn(
  start: () => AsyncGenerator<ChatStreamEvent>,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  let open = start;

  for (;;) {
    const calls: ToolCallEvent[] = [];
    let awaiting = false;

    useAnalystStore.setState({ status: 'thinking', pendingText: '' });

    for await (const event of open()) {
      if (signal.aborted) return;

      switch (event.type) {
        case 'delta':
          useAnalystStore.setState((state) => ({
            pendingText: state.pendingText + (event.text ?? ''),
          }));
          break;

        case 'message':
          // The step's final text. Committed to the transcript and the live
          // buffer cleared, so the streamed copy isn't rendered twice.
          if (event.text) {
            push({ id: newId('m'), kind: 'assistant', text: event.text });
          }
          useAnalystStore.setState({ pendingText: '' });
          break;

        case 'tool_call': {
          const call = event as ToolCallEvent;
          calls.push(call);
          push({
            id: call.tool_use_id,
            kind: 'tool',
            name: call.name,
            input: call.input ?? {},
            status: 'running',
          });
          break;
        }

        case 'awaiting_tools':
          awaiting = true;
          break;

        case 'error':
          push({ id: newId('m'), kind: 'error', text: event.message || 'The analyst failed.' });
          return;

        case 'done':
          return;
      }
    }

    // The stream ended without asking for anything: the turn is over.
    if (!awaiting || calls.length === 0) return;

    useAnalystStore.setState({ status: 'running-tools' });
    const results = await executeToolCalls(calls, toolContext());
    if (signal.aborted) return;

    for (const result of results) markTool(result);

    // Feed them back and keep reading. The server resumes the model loop from
    // exactly where it paused.
    open = () => submitToolResults(sessionId, results, signal);
  }
}

function toolContext(): ToolContext {
  return {
    onCatalogChanged: () => {
      void useCatalogStore.getState().refresh();
    },
    onChart: (spec) => push({ id: newId('c'), kind: 'chart', spec }),
    onSaveQuery: async (name, sql) => {
      await useHistoryStore.getState().addSnippet(name, sql);
    },
  };
}

function markTool(result: ClientToolResult): void {
  useAnalystStore.setState((state) => ({
    transcript: state.transcript.map((item) =>
      item.kind === 'tool' && item.id === result.tool_use_id
        ? {
            ...item,
            status: result.is_error ? 'error' : 'ok',
            detail: result.is_error ? String(result.content) : undefined,
          }
        : item,
    ),
  }));
}

function push(item: TranscriptItem): void {
  useAnalystStore.setState((state) => ({ transcript: [...state.transcript, item] }));
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The analyst failed.';
}
