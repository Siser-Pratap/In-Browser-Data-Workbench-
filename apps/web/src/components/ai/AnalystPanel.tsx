'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AlertCircle,
  BarChart3,
  Check,
  Database,
  FileText,
  Loader2,
  Send,
  Sparkles,
  Square,
  Table2,
  Terminal,
  X,
} from 'lucide-react';

import { AnalystConsentDialog } from '@/components/ai/AnalystConsentDialog';
import { Button } from '@/components/ui/Button';
import {
  getAnalystConsent,
  getAnalystConsentServerSnapshot,
  subscribeAnalystConsent,
} from '@/lib/ai/consent';
import { cn } from '@/lib/utils/cn';
import { useAnalystStore, type TranscriptItem } from '@/stores/analyst';
import { useCatalogStore } from '@/stores/catalog';

/**
 * The analyst conversation.
 *
 * The agent's working is shown, not hidden behind a spinner: every tool call
 * appears as it happens, with the SQL it ran. That's deliberate — an answer
 * derived from six queries you can't see is not something a data person should
 * be asked to trust, and showing the queries also makes a wrong one obvious and
 * correctable rather than silently baked into the conclusion.
 */
export function AnalystPanel({ onClose }: { onClose: () => void }) {
  const transcript = useAnalystStore((state) => state.transcript);
  const status = useAnalystStore((state) => state.status);
  const pendingText = useAnalystStore((state) => state.pendingText);
  const starters = useAnalystStore((state) => state.starters);
  const ask = useAnalystStore((state) => state.ask);
  const stop = useAnalystStore((state) => state.stop);
  const reset = useAnalystStore((state) => state.reset);
  const tables = useCatalogStore((state) => state.tables);

  const consented = useSyncExternalStore(
    subscribeAnalystConsent,
    getAnalystConsent,
    getAnalystConsentServerSnapshot,
  );

  const [question, setQuestion] = useState('');
  const [askingConsent, setAskingConsent] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows, the way a chat should.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [transcript.length, pendingText]);

  const busy = status !== 'idle';

  function submit(text: string) {
    if (!text.trim() || busy) return;
    if (!consented) {
      setAskingConsent(true);
      return;
    }
    setQuestion('');
    void ask(text);
  }

  return (
    <aside
      className="flex w-[26rem] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]"
      aria-label="AI analyst"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Sparkles className="size-3.5 text-[var(--color-accent)]" />
        <span className="text-xs font-semibold">Analyst</span>
        <div className="ml-auto flex items-center gap-1">
          {transcript.length > 0 && (
            <Button size="sm" onClick={reset} title="Start a new conversation">
              New
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
            aria-label="Close the analyst"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {transcript.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--color-ink-muted)]">
              Ask a question in plain English. The analyst will write and run SQL against your
              tables — as many queries as it needs — and explain what it found.
            </p>
            {tables.length === 0 && (
              <p className="text-xs text-[var(--color-warn)]">
                Load a file first — there are no tables to ask about yet.
              </p>
            )}
            {starters.length > 0 && (
              <div className="space-y-1">
                {starters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => submit(starter)}
                    className="block w-full rounded border border-[var(--color-border)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-raised)]"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {transcript.map((item) => (
          <TranscriptRow key={item.id} item={item} />
        ))}

        {pendingText && (
          <p className="text-xs whitespace-pre-wrap text-[var(--color-ink-muted)]">{pendingText}</p>
        )}

        {status === 'thinking' && !pendingText && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
            <Loader2 className="size-3 animate-spin" /> Thinking…
          </p>
        )}
        {status === 'running-tools' && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
            <Loader2 className="size-3 animate-spin" /> Running queries in your browser…
          </p>
        )}
      </div>

      <form
        className="flex shrink-0 gap-1.5 border-t border-[var(--color-border)] p-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(question);
        }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={tables.length === 0 ? 'Load a file first…' : 'Which region grew fastest?'}
          aria-label="Ask the analyst"
          disabled={tables.length === 0}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5 text-xs focus-visible:border-[var(--color-accent)] focus-visible:outline-none disabled:opacity-50"
        />
        {busy ? (
          <Button size="sm" variant="danger" icon={<Square className="size-3" />} onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon={<Send className="size-3" />}
            disabled={!question.trim() || tables.length === 0}
          >
            Ask
          </Button>
        )}
      </form>

      {askingConsent && (
        <AnalystConsentDialog
          onClose={() => setAskingConsent(false)}
          onGranted={() => {
            setAskingConsent(false);
            const pending = question;
            setQuestion('');
            void ask(pending);
          }}
        />
      )}
    </aside>
  );
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  list_tables: <Database className="size-3" />,
  get_schema: <Table2 className="size-3" />,
  get_profile: <FileText className="size-3" />,
  run_sql: <Terminal className="size-3" />,
  create_chart: <BarChart3 className="size-3" />,
  save_query: <FileText className="size-3" />,
};

const TOOL_LABELS: Record<string, string> = {
  list_tables: 'Listed the tables',
  get_schema: 'Read the schema',
  get_profile: 'Profiled',
  run_sql: 'Ran SQL',
  create_chart: 'Built a chart',
  save_query: 'Saved a query',
};

function TranscriptRow({ item }: { item: TranscriptItem }) {
  if (item.kind === 'user') {
    return (
      <p className="ml-6 rounded bg-[var(--color-accent)]/10 px-2 py-1.5 text-xs whitespace-pre-wrap">
        {item.text}
      </p>
    );
  }

  if (item.kind === 'assistant') {
    return <p className="text-xs whitespace-pre-wrap">{item.text}</p>;
  }

  if (item.kind === 'error') {
    return (
      <p className="flex items-start gap-1.5 rounded bg-[var(--color-danger)]/10 px-2 py-1.5 text-xs text-[var(--color-danger)]">
        <AlertCircle className="mt-0.5 size-3 shrink-0" />
        {item.text}
      </p>
    );
  }

  if (item.kind === 'chart') {
    // The spec is shown rather than rendered: the panel is narrow, and the
    // chart is more useful in the workbench where it can be edited.
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
        <BarChart3 className="size-3" /> Chart proposed:{' '}
        <span className="font-mono">{String(item.spec['type'] ?? 'chart')}</span>
      </p>
    );
  }

  const sql = typeof item.input['sql'] === 'string' ? item.input['sql'] : null;
  const target = typeof item.input['table'] === 'string' ? item.input['table'] : null;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5">
      <p
        className={cn(
          'flex items-center gap-1.5 text-[11px]',
          item.status === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-muted)]',
        )}
      >
        {item.status === 'running' ? (
          <Loader2 className="size-3 animate-spin" />
        ) : item.status === 'error' ? (
          <AlertCircle className="size-3" />
        ) : (
          <Check className="size-3 text-[var(--color-ok)]" />
        )}
        {TOOL_ICONS[item.name]}
        <span>
          {TOOL_LABELS[item.name] ?? item.name}
          {target ? ` ${target}` : ''}
        </span>
      </p>

      {sql && (
        <pre className="mt-1 max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
          {sql}
        </pre>
      )}

      {item.status === 'error' && item.detail && (
        <p className="mt-1 text-[11px] text-[var(--color-danger)]">{item.detail}</p>
      )}
    </div>
  );
}
