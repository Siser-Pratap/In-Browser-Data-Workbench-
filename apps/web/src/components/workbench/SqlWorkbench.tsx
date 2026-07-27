'use client';

import { useEffect } from 'react';

import { EditorToolbar } from '@/components/editor/EditorToolbar';
import { QueryTabs } from '@/components/editor/QueryTabs';
import { SqlEditor } from '@/components/editor/SqlEditor';
import { ResultsPanel } from '@/components/results/ResultsPanel';
import { Button } from '@/components/ui/Button';
import { SplitPane } from '@/components/ui/SplitPane';
import { formatSql } from '@/lib/sql/format';
import { useTabsStore } from '@/stores/tabs';

/**
 * The SQL view: tabs, editor and results.
 *
 * `SqlEditor` is keyed by tab id so switching tabs gives each one its own Monaco
 * instance — and therefore its own undo history and cursor position. Sharing one
 * editor and swapping the text would make Ctrl+Z on tab two undo an edit made in
 * tab one, which is the sort of thing that quietly destroys someone's query.
 */
export function SqlWorkbench() {
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeId);
  const runtime = useTabsStore((state) => state.runtime);
  const openTab = useTabsStore((state) => state.openTab);
  const setSql = useTabsStore((state) => state.setSql);
  const setChart = useTabsStore((state) => state.setChart);
  const runTab = useTabsStore((state) => state.runTab);
  const cancelTab = useTabsStore((state) => state.cancelTab);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeRuntime = active ? runtime[active.id] : undefined;

  // There is always at least one tab: an empty editor is a better invitation
  // than an empty panel with a button on it.
  useEffect(() => {
    if (tabs.length === 0) openTab();
  }, [tabs.length, openTab]);

  if (!active) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QueryTabs />

      <SplitPane
        initial={0.42}
        label="Resize the editor and results"
        top={
          <div className="flex h-full min-h-0 flex-col">
            <EditorToolbar
              sql={active.sql}
              running={activeRuntime?.status === 'running'}
              onRun={() => void runTab(active.id)}
              onCancel={() => void cancelTab(active.id)}
              onFormat={() => setSql(active.id, formatSql(active.sql))}
              onOpenInEditor={(sql) => openTab({ sql })}
            />
            <div className="min-h-0 flex-1">
              <SqlEditor
                key={active.id}
                value={active.sql}
                error={activeRuntime?.error ?? null}
                onChange={(value) => setSql(active.id, value)}
                onRun={(selection) => void runTab(active.id, selection)}
                onFormat={() => setSql(active.id, formatSql(active.sql))}
              />
            </div>
          </div>
        }
        bottom={
          <ResultsPanel
            runtime={
              activeRuntime ?? {
                status: 'idle',
                result: null,
                error: null,
                ranSql: null,
                cancelled: false,
              }
            }
            tabName={active.name}
            onOpenInEditor={(sql) => setSql(active.id, sql)}
            chart={active.chart ?? null}
            onChartChange={(chart) => setChart(active.id, chart)}
          />
        }
      />
    </div>
  );
}

/** Shown when the workspace has no data yet but the user opened the SQL view. */
export function EmptySqlState({ onAddData }: { onAddData: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-[var(--color-ink-muted)]">
        There are no tables to query yet.
      </p>
      <Button variant="primary" onClick={onAddData}>
        Add data
      </Button>
    </div>
  );
}
