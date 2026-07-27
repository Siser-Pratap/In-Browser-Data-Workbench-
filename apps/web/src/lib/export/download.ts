/**
 * Handing bytes to the browser as a file.
 *
 * Everything the workbench exports is produced locally — DuckDB writes the file
 * into its own virtual filesystem and we hand the buffer straight to a blob URL.
 * No upload, no server round-trip, no temporary link anyone else could follow.
 */

export function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string): void {
  // `bytes` may be a view onto a larger DuckDB heap buffer, so slice to exactly
  // the region we mean before wrapping it — otherwise the download can contain
  // whatever else happens to be adjacent in WASM memory.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType });
  downloadBlob(blob, filename);
}

export function downloadText(text: string, filename: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in Safari; one tick is enough
  // for the navigation to have started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const MIME_TYPES: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  parquet: 'application/vnd.apache.parquet',
  png: 'image/png',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  html: 'text/html',
};

/** A filesystem-safe basename derived from a tab or table name. */
export function safeFilename(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.\- ]+/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'export'
  );
}
