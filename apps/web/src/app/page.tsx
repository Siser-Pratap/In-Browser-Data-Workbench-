'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DataGrid } from '@/components/grid/DataGrid';
import { DropZone } from '@/components/ingest/DropZone';
import { ImportDialog } from '@/components/ingest/ImportDialog';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { Sidebar } from '@/components/layout/Sidebar';
import { StatusBar } from '@/components/layout/StatusBar';
import { TopBar } from '@/components/layout/TopBar';
import type { ImportOptions } from '@/lib/engine/types';
import { formatCount } from '@/lib/utils/format';
import { useDatasetStore } from '@/stores/datasets';

export default function WorkbenchPage() {
  const datasets = useDatasetStore((state) => state.datasets);
  const activeTable = useDatasetStore((state) => state.activeTable);
  const status = useDatasetStore((state) => state.status);
  const restoring = useDatasetStore((state) => state.restoring);
  const initEngine = useDatasetStore((state) => state.initEngine);
  const restoreFromDisk = useDatasetStore((state) => state.restoreFromDisk);
  const importFile = useDatasetStore((state) => state.importFile);

  // Files waiting to be confirmed; the dialog handles them one at a time so
  // each gets its own table name.
  const [queue, setQueue] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [stats, setStats] = useState<{ visibleRows: number; elapsedMs: number } | null>(null);

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
      }
    }
    void start();
  }, [restoreFromDisk, initEngine]);

  const pending = queue[0];

  async function onConfirm(options: ImportOptions) {
    if (!pending) return;
    setImporting(true);
    try {
      const info = await importFile(pending, options);
      toast.success(`Imported ${info.table}`, {
        description: `${formatCount(info.rowCount)} rows × ${info.columns.length} columns`,
      });
      setQueue((current) => current.slice(1));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          {datasets.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-lg">
                {restoring ? (
                  <p className="text-center text-sm text-[var(--color-ink-muted)]">
                    Restoring your workspace…
                  </p>
                ) : (
                  <>
                    <DropZone onFiles={(files) => setQueue((q) => [...q, ...files])} />
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
                  {activeTable && <DataGrid table={activeTable} onStats={setStats} />}
                </ErrorBoundary>
              </div>
            </>
          )}
        </main>
      </div>

      <StatusBar visibleRows={stats?.visibleRows} elapsedMs={stats?.elapsedMs} />

      {pending && (
        <ImportDialog
          file={pending}
          existingTables={datasets.map((dataset) => dataset.table)}
          importing={importing}
          onCancel={() => setQueue((current) => current.slice(1))}
          onConfirm={(options) => void onConfirm(options)}
        />
      )}
    </div>
  );
}
