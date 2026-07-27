'use client';

import { create } from 'zustand';

import { getEngine, resetEngine } from '@/lib/engine/engine';
import type { DatasetInfo, EngineStatus, ImportOptions } from '@/lib/engine/types';
import * as opfs from '@/lib/files/opfs';
import { track } from '@/lib/telemetry/telemetry';
import { readSheetRows } from '@/lib/files/xlsx';

/**
 * Workspace state: which datasets are loaded and whether the engine is up.
 *
 * The DuckDB handle deliberately lives outside the store (see
 * `lib/engine/engine.ts`). React state should hold plain, serialisable
 * descriptions of what exists; the engine is a long-lived resource with a
 * worker attached, and putting it in a store invites re-render churn and
 * accidental copies.
 */
interface DatasetState {
  status: EngineStatus;
  error: string | null;
  datasets: DatasetInfo[];
  activeTable: string | null;
  /** True while OPFS restore is in flight, so the UI doesn't flash "empty". */
  restoring: boolean;

  initEngine: () => Promise<void>;
  importFile: (file: File, options: ImportOptions) => Promise<DatasetInfo>;
  removeDataset: (table: string) => Promise<void>;
  setActiveTable: (table: string | null) => void;
  clearWorkspace: () => Promise<void>;
  restoreFromDisk: () => Promise<void>;
}

export const useDatasetStore = create<DatasetState>((set, get) => ({
  status: 'idle',
  error: null,
  datasets: [],
  activeTable: null,
  restoring: false,

  async initEngine() {
    if (get().status === 'ready' || get().status === 'initializing') return;
    set({ status: 'initializing', error: null });
    try {
      await getEngine().init();
      set({ status: 'ready' });
    } catch (error) {
      set({ status: 'error', error: messageOf(error) });
      throw error;
    }
  },

  async importFile(file, options) {
    await get().initEngine();
    const engine = getEngine();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const byteSize = bytes.byteLength;

    // Persist *before* importing. `registerFileBuffer` transfers the buffer to
    // the DuckDB worker, which detaches it here — read it afterwards and you
    // get zero bytes, which is exactly the empty file this used to write.
    // Copying instead would double peak memory on a file that may be hundreds
    // of megabytes, so order is the cheaper fix.
    const blobName = opfs.blobNameFor(options.table, options.format);
    const persisted = await opfs.saveFile(blobName, bytes);

    let imported;
    try {
      imported =
        options.format === 'xlsx'
          ? await engine.importJsonRows(options.table, await readSheetRows(bytes, options.sheet))
          : await engine.importFile(bytes, options);
    } catch (error) {
      // Don't leave a file behind that only exists to fail again on reload.
      if (persisted) await opfs.deleteFile(blobName);
      throw error;
    }

    const info: DatasetInfo = {
      ...imported,
      // `imported.byteSize` is measured after the transfer, so use the size we
      // captured while the buffer was still ours.
      byteSize,
      sourceFilename: file.name,
      importedAt: Date.now(),
    };

    if (persisted) {
      const manifest = await opfs.readManifest();
      await opfs.writeManifest([
        ...manifest.filter((entry) => entry.info.table !== info.table),
        { info, options, blobName },
      ]);
    }

    track('file.import');
    set((state) => ({
      datasets: [...state.datasets.filter((d) => d.table !== info.table), info],
      activeTable: info.table,
    }));
    return info;
  },

  async removeDataset(table) {
    await getEngine().dropTable(table);

    const manifest = await opfs.readManifest();
    const entry = manifest.find((item) => item.info.table === table);
    if (entry) {
      await opfs.deleteFile(entry.blobName);
      await opfs.writeManifest(manifest.filter((item) => item.info.table !== table));
    }

    set((state) => {
      const datasets = state.datasets.filter((d) => d.table !== table);
      return {
        datasets,
        activeTable:
          state.activeTable === table ? (datasets[0]?.table ?? null) : state.activeTable,
      };
    });
  },

  setActiveTable(table) {
    set({ activeTable: table });
  },

  async clearWorkspace() {
    await opfs.clearAll();
    await resetEngine();
    set({ datasets: [], activeTable: null, status: 'idle', error: null });
  },

  /**
   * Rebuild the workspace from OPFS.
   *
   * The files are re-imported rather than the tables being restored: DuckDB-WASM
   * is in-memory, so its catalogue does not survive a reload. Keeping the
   * original bytes and replaying the import is both simpler and self-healing.
   */
  async restoreFromDisk() {
    const manifest = await opfs.readManifest();
    if (manifest.length === 0) return;

    set({ restoring: true });
    try {
      await get().initEngine();
      const engine = getEngine();
      const restored: DatasetInfo[] = [];

      for (const entry of manifest) {
        const bytes = await opfs.readFile(entry.blobName);
        if (!bytes) continue;
        try {
          if (entry.options.format === 'xlsx') {
            await engine.importJsonRows(
              entry.options.table,
              await readSheetRows(bytes, entry.options.sheet),
            );
          } else {
            await engine.importFile(bytes, entry.options);
          }
          restored.push(entry.info);
        } catch {
          // One unreadable dataset shouldn't stop the rest from coming back.
        }
      }

      set((state) => ({
        datasets: restored,
        activeTable: state.activeTable ?? restored[0]?.table ?? null,
      }));
    } finally {
      set({ restoring: false });
    }
  },
}));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
