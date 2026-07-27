'use client';

import { create } from 'zustand';

import * as idb from '@/lib/storage/idb';
import { newId } from '@/lib/utils/id';

/**
 * Query history and pinned snippets.
 *
 * History is local and permanent-ish: it's a record of what the user did to
 * their own data, and it never leaves the browser. The cap exists so a long
 * session of iterating on one query doesn't grow the store without bound — the
 * oldest entries go first, since the recent ones are what anyone actually
 * re-runs.
 */

export interface HistoryEntry {
  id: string;
  sql: string;
  /** Epoch ms. */
  at: number;
  durationMs: number;
  /** Null when the query failed. */
  rowCount: number | null;
  ok: boolean;
  error?: string;
  /** Which tables existed when it ran, so an entry reads in context later. */
  tables: string[];
}

export interface Snippet {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
}

/** Beyond this the oldest entries are dropped. */
export const HISTORY_LIMIT = 500;

interface HistoryState {
  entries: HistoryEntry[];
  snippets: Snippet[];
  loaded: boolean;

  load: () => Promise<void>;
  record: (entry: Omit<HistoryEntry, 'id' | 'at'>) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  addSnippet: (name: string, sql: string) => Promise<Snippet>;
  removeSnippet: (id: string) => Promise<void>;
  renameSnippet: (id: string, name: string) => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  snippets: [],
  loaded: false,

  async load() {
    if (get().loaded) return;
    const [entries, snippets] = await Promise.all([
      idb.getAll<HistoryEntry>('history'),
      idb.getAll<Snippet>('snippets'),
    ]);
    set({
      entries: entries.sort((a, b) => b.at - a.at),
      snippets: snippets.sort((a, b) => a.name.localeCompare(b.name)),
      loaded: true,
    });
  },

  async record(entry) {
    const full: HistoryEntry = { ...entry, id: newId('q'), at: Date.now() };
    const previous = get().entries;
    const kept = [full, ...previous].slice(0, HISTORY_LIMIT);
    // Update React first: the panel should show the query the instant it runs,
    // not after a round-trip to IndexedDB.
    set({ entries: kept });
    await idb.put('history', full);

    // The in-memory list is capped by the slice above, but IndexedDB would keep
    // every row forever — so anything the cap just pushed out gets deleted too.
    if (previous.length >= HISTORY_LIMIT) {
      const surviving = new Set(kept.map((item) => item.id));
      const stored = await idb.getAll<HistoryEntry>('history');
      for (const row of stored) {
        if (!surviving.has(row.id)) await idb.remove('history', row.id);
      }
    }
  },

  async removeEntry(id) {
    set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) }));
    await idb.remove('history', id);
  },

  async clearHistory() {
    set({ entries: [] });
    await idb.clear('history');
  },

  async addSnippet(name, sql) {
    const snippet: Snippet = { id: newId('s'), name, sql, createdAt: Date.now() };
    set((state) => ({
      snippets: [...state.snippets, snippet].sort((a, b) => a.name.localeCompare(b.name)),
    }));
    await idb.put('snippets', snippet);
    return snippet;
  },

  async removeSnippet(id) {
    set((state) => ({ snippets: state.snippets.filter((snippet) => snippet.id !== id) }));
    await idb.remove('snippets', id);
  },

  async renameSnippet(id, name) {
    const snippet = get().snippets.find((item) => item.id === id);
    if (!snippet) return;
    const updated = { ...snippet, name };
    set((state) => ({
      snippets: state.snippets
        .map((item) => (item.id === id ? updated : item))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    await idb.put('snippets', updated);
  },
}));

/**
 * Filter history by a free-text query.
 *
 * Matching on the SQL text is what makes history usable as a memory aid — "the
 * one where I joined on customer_id" is how people search for a past query.
 */
export function searchHistory(entries: HistoryEntry[], query: string): HistoryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (entry) =>
      entry.sql.toLowerCase().includes(needle) ||
      entry.tables.some((table) => table.toLowerCase().includes(needle)),
  );
}
