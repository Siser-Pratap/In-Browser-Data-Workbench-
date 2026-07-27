import type { DatasetInfo, ImportOptions } from '@/lib/engine/types';

/**
 * Persist imported files so a reload restores the workspace.
 *
 * OPFS (Origin Private File System) is the right home for this: it's origin-
 * scoped, invisible to the user's Downloads folder, and fast enough to write
 * hundreds of megabytes. It's also *private* — consistent with the promise that
 * data never leaves the machine. Nothing here ever touches the network.
 *
 * Safari and older Firefox lack `getDirectory`, so every method degrades to a
 * no-op rather than throwing: losing session restore is a much smaller problem
 * than refusing to import a file.
 */

const ROOT_DIR = 'datasets';
const MANIFEST = 'manifest.json';

/** What we need to rebuild a dataset without re-asking the user anything. */
export interface PersistedDataset {
  info: DatasetInfo;
  options: ImportOptions;
  /** Filename inside the OPFS datasets directory. */
  blobName: string;
}

export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

async function rootDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsSupported()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(ROOT_DIR, { create: true });
  } catch {
    return null;
  }
}

export async function saveFile(
  blobName: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const dir = await rootDirectory();
  if (!dir) return false;

  if (data.byteLength === 0) {
    // Almost certainly a detached buffer — DuckDB's `registerFileBuffer`
    // transfers ownership, so anything read after an import is empty. Writing
    // it would produce a 0-byte file that silently breaks session restore.
    console.warn(`Refusing to persist ${blobName}: no bytes to write.`);
    return false;
  }

  try {
    const handle = await dir.getFileHandle(blobName, { create: true });
    const writable = await handle.createWritable();
    // The view is written as-is: it already spans exactly the bytes we want,
    // and copying would double peak memory on a large import.
    await writable.write(data);
    await writable.close();
    return true;
  } catch (error) {
    // Best-effort, but not silent — losing session restore should be visible
    // in the console rather than showing up later as an empty workspace.
    console.warn(`Could not persist ${blobName} to OPFS:`, error);
    return false;
  }
}

export async function readFile(blobName: string): Promise<Uint8Array | null> {
  const dir = await rootDirectory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(blobName);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function deleteFile(blobName: string): Promise<void> {
  const dir = await rootDirectory();
  if (!dir) return;
  await dir.removeEntry(blobName).catch(() => undefined);
}

export async function readManifest(): Promise<PersistedDataset[]> {
  const dir = await rootDirectory();
  if (!dir) return [];
  try {
    const handle = await dir.getFileHandle(MANIFEST);
    const text = await (await handle.getFile()).text();
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as PersistedDataset[]) : [];
  } catch {
    // No manifest yet, or it's corrupt — either way, start clean rather than
    // failing the whole app on parse.
    return [];
  }
}

export async function writeManifest(entries: PersistedDataset[]): Promise<void> {
  const dir = await rootDirectory();
  if (!dir) return;
  try {
    const handle = await dir.getFileHandle(MANIFEST, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(entries));
    await writable.close();
  } catch {
    // Persistence is best-effort; the in-memory workspace is still usable.
  }
}

/** Wipe everything this app has stored locally. */
export async function clearAll(): Promise<void> {
  if (!isOpfsSupported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(ROOT_DIR, { recursive: true });
  } catch {
    // Nothing stored, or the browser doesn't support it.
  }
}

export function blobNameFor(table: string, format: string): string {
  return `${table}.${format}`;
}
