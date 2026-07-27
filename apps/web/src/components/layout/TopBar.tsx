'use client';

import { Database, Moon, PanelLeft, Sun, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useDatasetStore } from '@/stores/datasets';
import { useUiStore } from '@/stores/ui';

export function TopBar() {
  const { theme, toggleTheme, toggleSidebar } = useUiStore();
  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);
  const setActiveTable = useDatasetStore((state) => state.setActiveTable);
  const clearWorkspace = useDatasetStore((state) => state.clearWorkspace);

  async function onClear() {
    if (datasets.length > 0) {
      const ok = window.confirm(
        `Remove all ${datasets.length} dataset(s) and delete the copies stored in this browser?`,
      );
      if (!ok) return;
    }
    await clearWorkspace();
    toast.success('Workspace cleared');
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3">
      <button
        type="button"
        onClick={toggleSidebar}
        className="rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
        aria-label="Toggle sidebar"
      >
        <PanelLeft className="size-4" />
      </button>

      <div className="flex items-center gap-2">
        <Database className="size-4 text-[var(--color-accent)]" />
        <span className="text-sm font-semibold">Data Workbench</span>
      </div>

      {datasets.length > 0 && (
        <label className="ml-2 flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
          <span className="sr-only">Active dataset</span>
          <select
            value={activeTable ?? ''}
            onChange={(event) => setActiveTable(event.target.value || null)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs text-[var(--color-ink)]"
          >
            {datasets.map((dataset) => (
              <option key={dataset.table} value={dataset.table}>
                {dataset.table}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="ml-auto flex items-center gap-1">
        {/* The privacy claim, stated where it's always visible. */}
        <span className="mr-2 hidden text-xs text-[var(--color-ink-muted)] sm:inline">
          Runs entirely in your browser
        </span>

        {datasets.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-danger)]"
            aria-label="Clear workspace"
            title="Clear workspace"
          >
            <Trash2 className="size-4" />
          </button>
        )}

        <button
          type="button"
          onClick={toggleTheme}
          className="rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </header>
  );
}
