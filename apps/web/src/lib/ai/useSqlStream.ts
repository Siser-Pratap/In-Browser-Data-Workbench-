'use client';

import { useCallback, useRef, useState } from 'react';

import type { SqlStreamEvent } from '@/lib/api/ai';

/**
 * Drive one of the streaming SQL endpoints and expose its state to React.
 *
 * Ask, fix and explain all emit the same event vocabulary (`delta`, `sql`,
 * `clarification`, `explanation`, `error`, `done`), so they share this hook
 * rather than each growing their own copy of the accumulate-and-abort logic.
 *
 * Two details are load-bearing:
 *
 * - **`AbortController` per run.** Stopping has to close the HTTP connection,
 *   not just stop rendering — an abandoned stream keeps the server generating,
 *   and generating costs the user tokens.
 * - **`runId` guards late events.** A second run started before the first
 *   finished would otherwise interleave: the old generator is still resolving
 *   when the new one begins, and whichever resolved last would win.
 */

export interface SqlStreamState {
  /** Text streamed so far — the model thinking out loud, shown live. */
  text: string;
  sql: string | null;
  explanation: string | null;
  /** The model asked for more information instead of guessing. */
  clarification: string | null;
  error: string | null;
  running: boolean;
  /** True once the stream ended, however it ended. */
  finished: boolean;
}

const EMPTY: SqlStreamState = {
  text: '',
  sql: null,
  explanation: null,
  clarification: null,
  error: null,
  running: false,
  finished: false,
};

export function useSqlStream() {
  const [state, setState] = useState<SqlStreamState>(EMPTY);
  const abort = useRef<AbortController | null>(null);
  const runId = useRef(0);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setState((current) => ({ ...current, running: false, finished: true }));
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    runId.current += 1;
    setState(EMPTY);
  }, []);

  /**
   * Consume a stream. `start` is a thunk so the caller supplies the endpoint
   * and its arguments while the abort signal is created here.
   */
  const run = useCallback(
    async (start: (signal: AbortSignal) => AsyncGenerator<SqlStreamEvent>) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const id = ++runId.current;

      setState({ ...EMPTY, running: true });

      try {
        for await (const event of start(controller.signal)) {
          if (id !== runId.current) return;
          setState((current) => reduce(current, event));
        }
      } catch (error) {
        if (id !== runId.current) return;
        // An abort is the user pressing Stop, not a failure to report.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : 'The request failed.',
        }));
      } finally {
        if (id === runId.current) {
          setState((current) => ({ ...current, running: false, finished: true }));
          abort.current = null;
        }
      }
    },
    [],
  );

  return { state, run, stop, reset };
}

/** Fold one event into the accumulated state. Exported for its tests. */
export function reduce(state: SqlStreamState, event: SqlStreamEvent): SqlStreamState {
  switch (event.type) {
    case 'delta':
      return { ...state, text: state.text + (event.text ?? '') };
    case 'sql':
      return {
        ...state,
        sql: event.sql,
        explanation: event.explanation ?? state.explanation,
      };
    case 'clarification':
      return { ...state, clarification: event.question };
    case 'explanation':
      return { ...state, explanation: event.text };
    case 'error':
      return { ...state, error: event.message || 'The AI request failed.' };
    case 'done':
      return { ...state, finished: true };
    default:
      return state;
  }
}
