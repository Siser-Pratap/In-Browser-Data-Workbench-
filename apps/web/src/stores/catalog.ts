'use client';

import { create } from 'zustand';

import { getEngine } from '@/lib/engine/engine';
import type { CatalogTable } from '@/lib/engine/types';

/**
 * What the engine currently contains, for autocomplete and the schema explorer.
 *
 * Kept separate from the datasets store because the two answer different
 * questions. `datasets` is "which files did the user import" — it's about
 * provenance and OPFS. This is "what can I write in a query right now", which
 * also includes tables the user created with `CREATE TABLE AS` or a
 * transformation, and which therefore has to be re-read from DuckDB rather than
 * accumulated by the app.
 */
interface CatalogState {
  tables: CatalogTable[];
  refreshing: boolean;
  refresh: () => Promise<void>;
  clear: () => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  tables: [],
  refreshing: false,

  async refresh() {
    const engine = getEngine();
    if (!engine.isReady) return;
    set({ refreshing: true });
    try {
      set({ tables: await engine.catalog() });
    } catch {
      // A catalogue read failing shouldn't surface as an error toast — it just
      // means autocomplete is briefly stale.
    } finally {
      set({ refreshing: false });
    }
  },

  clear() {
    set({ tables: [] });
  },
}));
