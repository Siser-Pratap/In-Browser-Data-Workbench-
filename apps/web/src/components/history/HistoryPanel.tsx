'use client';

import { useMemo, useState } from 'react';
import { BookmarkPlus, Play, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { CONTROL_CLASS } from '@/components/ui/Field';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatDuration } from '@/lib/utils/format';
import { searchHistory, useHistoryStore } from '@/stores/history';
import { useTabsStore } from '@/stores/tabs';

/**
 * Query history and saved snippets.
 *
 * Both live in the same panel because they're the same thing at different
 * levels of commitment — a snippet is a history entry someone decided to keep.
 * "Pin" is therefore one click from any entry rather than a separate save flow.
 */
export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'history' | 'snippets'>('history');
  const [query, setQuery] = useState('');

  const entries = useHistoryStore((state) => state.entries);
  const snippets = useHistoryStore((state) => state.snippets);
  const addSnippet = useHistoryStore((state) => state.addSnippet);
  const removeEntry = useHistoryStore((state) => state.removeEntry);
  const removeSnippet = useHistoryStore((state) => state.removeSnippet);
  const clearHistory = useHistoryStore((state) => state.clearHistory);
  const openTab = useTabsStore((state) => state.openTab);

  const filtered = useMemo(() => searchHistory(entries, query), [entries, query]);
  const filteredSnippets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snippets;
    return snippets.filter(
      (snippet) =>
        snippet.name.toLowerCase().includes(needle) ||
        snippet.sql.toLowerCase().includes(needle),
    );
  }, [snippets, query]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
        {(['history', 'snippets'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={cn(
              'rounded px-2 py-1 text-xs capitalize',
              tab === name
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            {name}
            <span className="ml-1 opacity-60">
              {name === 'history' ? entries.length : snippets.length}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history panel"
          className="ml-auto rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="relative border-b border-[var(--color-border)] p-2">
        <Search className="absolute top-1/2 left-4 size-3 -translate-y-1/2 text-[var(--color-ink-muted)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tab === 'history' ? 'Search queries…' : 'Search snippets…'}
          aria-label="Search"
          className={cn(CONTROL_CLASS, 'pl-7 text-xs')}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'history' ? (
          filtered.length === 0 ? (
            <Empty>
              {entries.length === 0
                ? 'Queries you run will show up here.'
                : 'Nothing matches that search.'}
            </Empty>
          ) : (
            filtered.map((entry) => (
              <div
                key={entry.id}
                className="group border-b border-[var(--color-border)]/60 px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-ink-muted)]">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      entry.ok ? 'bg-[var(--color-ok)]' : 'bg-[var(--color-danger)]',
                    )}
                    aria-label={entry.ok ? 'succeeded' : 'failed'}
                  />
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleTimeString()}
                  </time>
                  <span>{formatDuration(entry.durationMs)}</span>
                  {entry.rowCount !== null && <span>{formatCount(entry.rowCount)} rows</span>}

                  <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label="Run again"
                      title="Run again in a new tab"
                      onClick={() => openTab({ sql: entry.sql, run: true })}
                      className="rounded p-0.5 hover:text-[var(--color-ink)]"
                    >
                      <Play className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label="Pin as snippet"
                      title="Pin as snippet"
                      onClick={async () => {
                        const name = window.prompt('Name this snippet', firstLine(entry.sql));
                        if (!name?.trim()) return;
                        await addSnippet(name.trim(), entry.sql);
                        toast.success('Pinned as a snippet');
                      }}
                      className="rounded p-0.5 hover:text-[var(--color-ink)]"
                    >
                      <BookmarkPlus className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label="Remove from history"
                      onClick={() => void removeEntry(entry.id)}
                      className="rounded p-0.5 hover:text-[var(--color-danger)]"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => openTab({ sql: entry.sql })}
                  title="Open in a new tab"
                  className="mt-0.5 line-clamp-3 w-full text-left font-mono text-[11px] whitespace-pre-wrap text-[var(--color-ink)] hover:text-[var(--color-accent)]"
                >
                  {entry.sql}
                </button>
                {entry.error && (
                  <p className="mt-0.5 truncate text-[10px] text-[var(--color-danger)]">
                    {entry.error}
                  </p>
                )}
              </div>
            ))
          )
        ) : filteredSnippets.length === 0 ? (
          <Empty>
            {snippets.length === 0
              ? 'Pin a query from history, or save one from the editor toolbar.'
              : 'Nothing matches that search.'}
          </Empty>
        ) : (
          filteredSnippets.map((snippet) => (
            <div
              key={snippet.id}
              className="group border-b border-[var(--color-border)]/60 px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{snippet.name}</span>
                <button
                  type="button"
                  aria-label={`Run ${snippet.name}`}
                  onClick={() => openTab({ name: snippet.name, sql: snippet.sql, run: true })}
                  className="rounded p-0.5 text-[var(--color-ink-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-ink)] focus:opacity-100"
                >
                  <Play className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${snippet.name}`}
                  onClick={() => void removeSnippet(snippet.id)}
                  className="rounded p-0.5 text-[var(--color-ink-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] focus:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
              <pre className="mt-0.5 line-clamp-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--color-ink-muted)]">
                {snippet.sql}
              </pre>
            </div>
          ))
        )}
      </div>

      {tab === 'history' && entries.length > 0 && (
        <div className="border-t border-[var(--color-border)] p-2">
          <Button
            size="sm"
            variant="danger"
            className="w-full"
            onClick={() => {
              if (window.confirm('Clear all query history? Snippets are kept.')) {
                void clearHistory();
              }
            }}
          >
            Clear history
          </Button>
        </div>
      )}
    </aside>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-3 text-xs text-[var(--color-ink-muted)]">{children}</p>;
}

function firstLine(sql: string): string {
  return sql.split('\n')[0]?.slice(0, 60) ?? 'Snippet';
}
