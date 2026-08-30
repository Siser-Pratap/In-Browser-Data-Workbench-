/**
 * Consent for the AI analyst to see query results.
 *
 * Every other AI surface in this app sends **schema only** — table and column
 * names and types. The analyst is different in kind: to answer "which region
 * underperformed" it has to run queries and read the numbers back, so actual
 * cell values leave the browser. That is a real departure from the promise the
 * rest of the product makes, so it is gated on an explicit, revocable yes
 * rather than folded in silently.
 *
 * Deliberately *not* part of the telemetry module even though the storage
 * pattern is identical. Telemetry's guarantee is that it records counts and
 * transmits nothing; putting a flag that authorises data egress in the same
 * file would undermine the one place in the codebase whose whole point is that
 * it cannot leak anything.
 */

const STORAGE_KEY = 'workbench-analyst-consent';

let snapshot: boolean | null = null;
const listeners = new Set<() => void>();

export function subscribeAnalystConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAnalystConsent(): boolean {
  snapshot ??= read();
  return snapshot;
}

/** The server never has this, and consent is denied until proven otherwise. */
export function getAnalystConsentServerSnapshot(): boolean {
  return false;
}

export function setAnalystConsent(granted: boolean): void {
  snapshot = granted;
  try {
    if (granted) globalThis.localStorage?.setItem(STORAGE_KEY, 'true');
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // A locked-down profile can refuse storage. The consent still holds for
    // this session; it just won't be remembered, which fails safe — the user
    // is asked again rather than assumed to have agreed.
  }
  for (const listener of listeners) listener();
}

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Tests only. */
export function resetAnalystConsentCache(): void {
  snapshot = null;
}
