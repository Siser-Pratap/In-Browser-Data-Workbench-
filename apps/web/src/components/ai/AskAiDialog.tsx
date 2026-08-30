'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Square } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { explainSql, fixSql, generateSql } from '@/lib/api/ai';
import { useSqlStream } from '@/lib/ai/useSqlStream';
import { track } from '@/lib/telemetry/telemetry';
import { useCatalogStore } from '@/stores/catalog';

export type AskMode =
  | { kind: 'ask' }
  | { kind: 'fix'; sql: string; error: string }
  | { kind: 'explain'; sql: string };

/**
 * The AI SQL surfaces: ask, fix and explain.
 *
 * One dialog for all three because they differ only in what starts the stream
 * and what the result is for — the streaming, stopping, error and context-
 * disclosure behaviour is identical, and duplicating it three times is how the
 * three drift apart.
 *
 * The generated SQL is **never run here**. It is offered, and the user puts it
 * in the editor and runs it themselves. That's the product's trust model, not a
 * missing feature: proposals you have to read before executing are how someone
 * learns to trust — and to check — a model's SQL.
 */
export function AskAiDialog({
  mode,
  onClose,
  onUseSql,
}: {
  mode: AskMode;
  onClose: () => void;
  onUseSql: (sql: string) => void;
}) {
  const tables = useCatalogStore((state) => state.tables);
  const { state, run, stop } = useSqlStream();
  const [question, setQuestion] = useState('');

  // Fix and explain have everything they need already, so they start on open.
  // Ask waits for a question.
  useEffect(() => {
    if (mode.kind === 'fix') {
      track('ai.fix');
      void run((signal) => fixSql(mode.sql, mode.error, tables, signal));
    } else if (mode.kind === 'explain') {
      track('ai.explain');
      void run((signal) => explainSql(mode.sql, tables, signal));
    }
    // Intentionally once per mount: re-running on every `tables` change would
    // restart the stream when the catalogue refreshes mid-answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title =
    mode.kind === 'ask' ? 'Ask AI' : mode.kind === 'fix' ? 'Fix this query' : 'Explain this query';

  return (
    <Dialog
      title={title}
      description="The model proposes SQL. Nothing runs until you choose to run it."
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          {state.running ? (
            <Button variant="danger" icon={<Square className="size-3" />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
          {state.sql && (
            <Button
              variant="primary"
              onClick={() => {
                track('ai.sql.accept');
                onUseSql(state.sql!);
                onClose();
              }}
            >
              Put it in the editor
            </Button>
          )}
        </>
      }
    >
      {mode.kind === 'ask' && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!question.trim()) return;
            track('ai.sql');
            void run((signal) => generateSql(question.trim(), tables, signal));
          }}
        >
          <input
            autoFocus
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Total revenue per region, highest first"
            aria-label="Your question"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm focus-visible:border-[var(--color-accent)] focus-visible:outline-none"
          />
          <Button
            type="submit"
            variant="primary"
            icon={<Sparkles className="size-3.5" />}
            busy={state.running}
            disabled={!question.trim()}
          >
            Ask
          </Button>
        </form>
      )}

      {/* What was sent, stated rather than implied. The user is entitled to know
          that schema names left the browser — and that values did not. */}
      <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
        Sent to the server: {tables.length} table name{tables.length === 1 ? '' : 's'} and their
        column names and types. No rows, no cell values.
      </p>

      {state.error && (
        <p role="alert" className="mt-3 rounded bg-[var(--color-danger)]/10 p-2 text-xs text-[var(--color-danger)]">
          {state.error}
        </p>
      )}

      {state.clarification && (
        <div className="mt-3 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-2 text-xs">
          <p className="font-medium">The model needs more detail:</p>
          <p className="mt-1">{state.clarification}</p>
        </div>
      )}

      {/* Live model text, shown while streaming so the wait isn't a blank box.
          Hidden once real SQL lands, which is the answer they actually want. */}
      {!state.sql && !state.explanation && state.text && (
        <pre className="mt-3 max-h-48 overflow-auto rounded bg-[var(--color-canvas)] p-2 font-mono text-[11px] whitespace-pre-wrap">
          {state.text}
        </pre>
      )}

      {state.sql && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium">Proposed SQL</p>
          <pre className="max-h-56 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 font-mono text-[11px] whitespace-pre-wrap">
            {state.sql}
          </pre>
        </div>
      )}

      {state.explanation && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium">Explanation</p>
          <p className="text-xs whitespace-pre-wrap text-[var(--color-ink-muted)]">
            {state.explanation}
          </p>
        </div>
      )}

      {state.running && !state.text && (
        <p className="mt-3 text-xs text-[var(--color-ink-muted)]">Thinking…</p>
      )}
    </Dialog>
  );
}
