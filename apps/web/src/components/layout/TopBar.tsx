'use client';

import { useState } from 'react';
import {
  Command,
  Database,
  History,
  LayoutDashboard,
  Moon,
  PanelLeft,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  Terminal,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { AccountMenu } from '@/components/auth/AccountMenu';
import { WorkspaceSwitcher } from '@/components/cloud/WorkspaceSwitcher';
import { PrivacySettings } from '@/components/layout/PrivacySettings';
import { WorkbenchFileMenu } from '@/components/workbench/WorkbenchFileMenu';
import { apiConfigured } from '@/lib/api/config';
import { cn } from '@/lib/utils/cn';
import { useCatalogStore } from '@/stores/catalog';
import { useDatasetStore } from '@/stores/datasets';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore, type View } from '@/stores/ui';

const VIEWS: { view: View; label: string; icon: React.ReactNode }[] = [
  { view: 'data', label: 'Data', icon: <Table2 className="size-3.5" /> },
  { view: 'sql', label: 'SQL', icon: <Terminal className="size-3.5" /> },
  { view: 'dashboards', label: 'Dashboards', icon: <LayoutDashboard className="size-3.5" /> },
];

export function TopBar() {
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleHistory = useUiStore((state) => state.toggleHistory);
  const historyOpen = useUiStore((state) => state.historyOpen);
  const toggleAnalyst = useUiStore((state) => state.toggleAnalyst);
  const analystOpen = useUiStore((state) => state.analystOpen);
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);
  const setActiveTable = useDatasetStore((state) => state.setActiveTable);
  const clearWorkspace = useDatasetStore((state) => state.clearWorkspace);
  const clearTabs = useTabsStore((state) => state.clearAll);
  const clearCatalog = useCatalogStore((state) => state.clear);

  async function onClear() {
    if (datasets.length > 0) {
      const ok = window.confirm(
        `Remove all ${datasets.length} dataset(s) and delete the copies stored in this browser?`,
      );
      if (!ok) return;
    }
    await clearWorkspace();
    clearTabs();
    clearCatalog();
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

      <nav
        aria-label="Main view"
        className="ml-2 flex items-center gap-0.5 rounded-md bg-[var(--color-canvas)] p-0.5"
      >
        {VIEWS.map((entry) => (
          <button
            key={entry.view}
            type="button"
            aria-current={view === entry.view}
            onClick={() => setView(entry.view)}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs',
              view === entry.view
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-sm'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </nav>

      {datasets.length > 0 && view === 'data' && (
        <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
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
        {/* The privacy claim, stated where it's always visible.
            Once an API is configured the unqualified "entirely" would be
            overclaiming — queries still run locally, but sign-in and cloud save
            do talk to a server. The narrower sentence is the one that stays
            true, so it's the one shown. */}
        <span className="mr-2 hidden text-xs text-[var(--color-ink-muted)] xl:inline">
          {apiConfigured() ? 'Your data stays in your browser' : 'Runs entirely in your browser'}
        </span>

        <WorkspaceSwitcher />
        <AccountMenu />

        <WorkbenchFileMenu />

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          // The visible "⌘K" has to be part of the accessible name, not
          // replaced by it: a speech-control user says what they can see, and
          // "open command palette" alone wouldn't match the visible label.
          aria-label="Open command palette ⌘K"
          title="Command palette (Cmd/Ctrl+K)"
        >
          <Command className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">⌘K</span>
        </button>

        {apiConfigured() && (
          <button
            type="button"
            onClick={toggleAnalyst}
            aria-pressed={analystOpen}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1.5 text-xs hover:bg-[var(--color-surface-raised)]',
              analystOpen
                ? 'text-[var(--color-accent)]'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
            aria-label="Toggle the AI analyst"
            title="Ask a question in English; the analyst writes and runs the SQL"
          >
            <Sparkles className="size-3.5" />
            <span className="hidden lg:inline">Analyst</span>
          </button>
        )}

        <button
          type="button"
          onClick={toggleHistory}
          aria-pressed={historyOpen}
          className={cn(
            'rounded p-1.5 hover:bg-[var(--color-surface-raised)]',
            historyOpen
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
          )}
          aria-label="Toggle query history"
          title="Query history"
        >
          <History className="size-4" />
        </button>

        {datasets.length > 0 && (
          <button
            type="button"
            onClick={() => void onClear()}
            className="rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-danger)]"
            aria-label="Clear workspace"
            title="Clear workspace"
          >
            <Trash2 className="size-4" />
          </button>
        )}

        <button
          type="button"
          onClick={() => setPrivacyOpen(true)}
          className="rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          aria-label="Privacy and usage settings"
          title="Privacy"
        >
          <ShieldCheck className="size-4" />
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          className="rounded p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>

      {privacyOpen && <PrivacySettings onClose={() => setPrivacyOpen(false)} />}
    </header>
  );
}
