/**
 * A very small IndexedDB key-value layer.
 *
 * Query history, snippets, chart specs and dashboards are all "a list of small
 * JSON records that must survive a reload". localStorage would fit the shape but
 * not the size — it's a synchronous ~5 MB budget shared with everything else on
 * the origin, and a few hundred history entries plus dashboards with inlined
 * chart specs will find that ceiling. IndexedDB is asynchronous, roughly
 * unbounded, and already required for nothing else here, so one tiny wrapper
 * covers every case rather than pulling in a dependency.
 *
 * As with OPFS: unsupported or blocked storage degrades to a no-op rather than
 * throwing. Losing history is a far smaller problem than a workbench that won't
 * open in a locked-down browser profile.
 */

const DB_NAME = 'workbench';
/** Bump when adding an object store below. */
const DB_VERSION = 1;

export const STORES = ['history', 'snippets', 'dashboards'] as const;
export type StoreName = (typeof STORES)[number];

export interface Record_ {
  id: string;
}

let connecting: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  connecting ??= new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    // Private-mode Firefox and locked-down profiles reject the open outright.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return connecting;
}

async function transaction<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const request = run(tx.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function getAll<T extends Record_>(store: StoreName): Promise<T[]> {
  const rows = await transaction<T[]>(store, 'readonly', (objectStore) =>
    objectStore.getAll() as IDBRequest<T[]>,
  );
  return rows ?? [];
}

export async function put<T extends Record_>(store: StoreName, value: T): Promise<void> {
  await transaction(store, 'readwrite', (objectStore) => objectStore.put(value));
}

export async function putMany<T extends Record_>(store: StoreName, values: T[]): Promise<void> {
  for (const value of values) await put(store, value);
}

export async function remove(store: StoreName, id: string): Promise<void> {
  await transaction(store, 'readwrite', (objectStore) => objectStore.delete(id));
}

export async function clear(store: StoreName): Promise<void> {
  await transaction(store, 'readwrite', (objectStore) => objectStore.clear());
}

/** Wipe every store — part of "clear workspace". */
export async function clearAll(): Promise<void> {
  for (const store of STORES) await clear(store);
}

/** Reset the memoized connection; only used by tests. */
export function resetConnection(): void {
  connecting = null;
}
