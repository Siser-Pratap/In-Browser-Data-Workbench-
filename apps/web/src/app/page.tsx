'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DataGrid } from '@/components/grid/DataGrid';
import { HistoryPanel } from '@/components/history/HistoryPanel';
import { DropZone } from '@/components/ingest/DropZone';
import { ImportDialog } from '@/components/ingest/ImportDialog';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { Sidebar } from '@/components/layout/Sidebar';
import { StatusBar } from '@/components/layout/StatusBar';
import { TopBar } from '@/components/layout/TopBar';
import { FirstRunTour } from '@/components/onboarding/FirstRunTour';
import { SampleDataButton } from '@/components/onboarding/SampleDataButton';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { useCommands } from '@/components/palette/useCommands';
import {
  LazyAnalystPanel,
  LazyDashboardsView,
  LazySqlWorkbench,
} from '@/components/workbench/lazy';
import { EmptySqlState } from '@/components/workbench/SqlWorkbench';
import { apiConfigured } from '@/lib/api/config';
import type { ImportOptions } from '@/lib/engine/types';
import { track } from '@/lib/telemetry/telemetry';
import { formatCount } from '@/lib/utils/format';
import { useCatalogStore } from '@/stores/catalog';
import { useDatasetStore } from '@/stores/datasets';
import { useHistoryStore } from '@/stores/history';
import { useUiStore } from '@/stores/ui';

export default function WorkbenchPage() {
  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);
  const status = useDatasetStore((state) => state.status);
  const restoring = useDatasetStore((state) => state.restoring);
  const initEngine = useDatasetStore((state) => state.initEngine);
  const restoreFromDisk = useDatasetStore((state) => state.restoreFromDisk);
  const importFile = useDatasetStore((state) => state.importFile);

  const refreshCatalog = useCatalogStore((state) => state.refresh);
  const loadHistory = useHistoryStore((state) => state.load);

  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const historyOpen = useUiStore((state) => state.historyOpen);
  const toggleHistory = useUiStore((state) => state.toggleHistory);
  const analystOpen = useUiStore((state) => state.analystOpen);
  const toggleAnalyst = useUiStore((state) => state.toggleAnalyst);
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);

  // Files waiting to be confirmed; the dialog handles them one at a time so
  // each gets its own table name.
  const [queue, setQueue] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [stats, setStats] = useState<{ visibleRows: number; elapsedMs: number } | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Boot the engine first, unconditionally. `restoreFromDisk` returns early
    // when there's nothing saved, so relying on it to start the engine left a
    // first-time visitor staring at "Engine idle" — and paying the WASM startup
    // cost later, at their first import, instead of now while they're reading.
    async function start() {
      try {
        await initEngine();
        await restoreFromDisk();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to start the engine');
      } finally {
        await refreshCatalog();
      }
    }
    void start();
    void loadHistory();
  }, [restoreFromDisk, initEngine, refreshCatalog, loadHistory]);

  // Global shortcuts. Registered on the window rather than a container so they
  // work regardless of what has focus — including Monaco, which swallows most
  // keys inside the editor.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        track('palette.open');
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPaletteOpen]);

  const onAddData = useCallback(() => filePicker.current?.click(), []);
  const commands = useCommands({ onAddData });

  const pending = queue[0];

  async function onConfirm(options: ImportOptions) {
    if (!pending) return;
    setImporting(true);
    try {
      const info = await importFile(pending, options);
      toast.success(`Imported ${info.table}`, {
        description: `${formatCount(info.rowCount)} rows × ${info.columns.length} columns`,
      });
      await refreshCatalog();
      setQueue((current) => current.slice(1));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  const hasData = datasets.length > 0;

  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === 'dashboards' ? (
            <ErrorBoundary>
              <LazyDashboardsView />
            </ErrorBoundary>
          ) : view === 'sql' ? (
            hasData ? (
              <ErrorBoundary>
                <LazySqlWorkbench />
              </ErrorBoundary>
            ) : (
              <EmptySqlState onAddData={onAddData} />
            )
          ) : !hasData ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-lg">
                {restoring ? (
                  <p className="text-center text-sm text-[var(--color-ink-muted)]">
                    Restoring your workspace…
                  </p>
                ) : (
                  <>
                    <DropZone onFiles={(files) => setQueue((q) => [...q, ...files])} />
                    <div className="mt-3 flex justify-center">
                      <SampleDataButton />
                    </div>
                    {status === 'error' && (
                      <p className="mt-3 text-center text-xs text-[var(--color-danger)]">
                        The query engine failed to start. Check that your browser supports
                        WebAssembly.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="border-b border-[var(--color-border)] px-3 py-2">
                <DropZone compact onFiles={(files) => setQueue((q) => [...q, ...files])} />
              </div>
              <div className="min-h-0 flex-1">
                <ErrorBoundary>
                  {activeTable && (
                    <DataGrid key={activeTable} table={activeTable} onStats={setStats} />
                  )}
                </ErrorBoundary>
              </div>
            </>
          )}
        </main>

        {historyOpen && <HistoryPanel onClose={toggleHistory} />}

        {/* Rendered beside the workbench rather than over it: the agent's
            queries are worth reading against the data they came from. */}
        {analystOpen && apiConfigured() && (
          <ErrorBoundary>
            <LazyAnalystPanel onClose={toggleAnalyst} />
          </ErrorBoundary>
        )}
      </div>

      <StatusBar visibleRows={stats?.visibleRows} elapsedMs={stats?.elapsedMs} />

      {/* Hidden picker so the palette and empty states can open a file dialog
          without each rendering their own input. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        data-testid="file-picker"
        accept=".csv,.tsv,.json,.parquet,.xlsx,.xls"
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          if (files.length > 0) {
            setQueue((q) => [...q, ...files]);
            setView('data');
          }
          event.target.value = '';
        }}
      />

      {pending && (
        <ImportDialog
          file={pending}
          existingTables={datasets.map((dataset) => dataset.table)}
          importing={importing}
          onCancel={() => setQueue((current) => current.slice(1))}
          onConfirm={(options) => void onConfirm(options)}
        />
      )}

      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}

      <FirstRunTour />
    </div>
  );
}
