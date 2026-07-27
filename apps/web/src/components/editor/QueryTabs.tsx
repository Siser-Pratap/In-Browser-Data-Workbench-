'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import { cn } from '@/lib/utils/cn';
import { useTabsStore } from '@/stores/tabs';

/**
 * The query tab strip.
 *
 * Double-clicking a tab renames it in place — query tabs accumulate fast, and
 * "Query 7" tells you nothing three days later, so renaming needs to be one
 * gesture rather than a dialog.
 */
export function QueryTabs() {
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeId);
  const runtime = useTabsStore((state) => state.runtime);
  const setActive = useTabsStore((state) => state.setActive);
  const closeTab = useTabsStore((state) => state.closeTab);
  const openTab = useTabsStore((state) => state.openTab);
  const renameTab = useTabsStore((state) => state.renameTab);

  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div
      role="tablist"
      aria-label="Query tabs"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] px-1"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const status = runtime[tab.id]?.status;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={cn(
              'group flex shrink-0 items-center gap-1 border-b-2 px-2 py-1.5 text-xs',
              isActive
                ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            {status === 'running' && (
              <span
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-warn)]"
                aria-label="running"
              />
            )}
            {status === 'error' && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-[var(--color-danger)]"
                aria-label="failed"
              />
            )}

            {editing === tab.id ? (
              <input
                autoFocus
                defaultValue={tab.name}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value) renameTab(tab.id, value);
                  setEditing(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setEditing(null);
                }}
                className="w-24 rounded border border-[var(--color-accent)] bg-[var(--color-surface-raised)] px-1 text-xs outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setActive(tab.id)}
                onDoubleClick={() => setEditing(tab.id)}
                title={`${tab.name} — double-click to rename`}
                className="max-w-40 truncate"
              >
                {tab.name}
              </button>
            )}

            <button
              type="button"
              onClick={() => closeTab(tab.id)}
              aria-label={`Close ${tab.name}`}
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] focus:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => openTab()}
        aria-label="New query tab"
        title="New query tab"
        className="shrink-0 rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
