'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

import { filterCommands, type Matchable } from '@/lib/palette/match';
import { cn } from '@/lib/utils/cn';

export interface Command extends Matchable {
  id: string;
  group: string;
  hint?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

/**
 * The command palette.
 *
 * The point of a palette is that it's faster than finding the control, which
 * means it has to be reachable and dismissable without the mouse and it has to
 * rank well — hence the fuzzy scoring in `lib/palette/match`. Results stay
 * grouped so the list still reads as a map of the app when nothing is typed.
 */
export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % Math.max(1, matches.length));
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + matches.length) % Math.max(1, matches.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = matches[highlighted];
      if (match) {
        onClose();
        match.item.run();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search className="size-4 shrink-0 text-[var(--color-ink-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // Any change to the result set invalidates the cursor; leaving it
              // where it was means Enter runs whatever has slid into that slot.
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command, a table, or a snippet…"
            aria-label="Command"
            aria-activedescendant={matches[highlighted] ? `command-${highlighted}` : undefined}
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-[var(--color-ink-muted)]"
          />
        </div>

        <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {matches.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[var(--color-ink-muted)]">
              Nothing matches “{query}”.
            </p>
          ) : (
            matches.map((match, index) => {
              const showGroup = match.item.group !== lastGroup;
              lastGroup = match.item.group;
              return (
                <div key={match.item.id}>
                  {showGroup && (
                    <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-[var(--color-ink-muted)] uppercase">
                      {match.item.group}
                    </p>
                  )}
                  <button
                    type="button"
                    id={`command-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === highlighted}
                    onPointerEnter={() => setHighlighted(index)}
                    onClick={() => {
                      onClose();
                      match.item.run();
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                      index === highlighted && 'bg-[var(--color-accent)]/15',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{match.item.label}</span>
                    {match.item.hint && (
                      <span className="shrink-0 font-mono text-[10px] text-[var(--color-ink-muted)]">
                        {match.item.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
