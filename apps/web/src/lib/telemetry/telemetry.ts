/**
 * Feature-usage counting — opt-in, local, and content-free.
 *
 * The plan asks for telemetry that respects the product's premise. That rules
 * out most of what "telemetry" normally means, so this is deliberately narrow:
 *
 *   • **Opt-in.** Off until the user turns it on. Nothing is recorded before
 *     that, and turning it off deletes what was recorded.
 *   • **Counts only.** The recorded value is a number per event name. There is
 *     no payload parameter to accidentally pass a table name, a column, a query
 *     or a cell value through.
 *   • **Local.** Nothing is transmitted. There is no endpoint, no queue and no
 *     beacon — the counts exist so the user can see them and so a future
 *     opt-in export has something honest to send.
 *
 * If this ever grows a network call, the consent copy has to change with it.
 */

const STORAGE_KEY = 'workbench-telemetry';

/**
 * The complete set of events. A closed union rather than a free-form string:
 * it's what guarantees no caller can invent an event name carrying user data.
 */
export type TelemetryEvent =
  | 'file.import'
  | 'file.import.sample'
  | 'query.run'
  | 'query.fail'
  | 'query.cancel'
  | 'transform.build'
  | 'chart.create'
  | 'dashboard.create'
  | 'dashboard.export'
  | 'result.export'
  | 'workspace.export'
  | 'workspace.import'
  | 'palette.open'
  // Cloud and AI. Counts only, exactly like the rest — no workspace name, no
  // question text, no SQL. That these features talk to a server changes nothing
  // about what this module is allowed to record.
  | 'account.sign_in'
  | 'account.sign_up'
  | 'workspace.cloud_create'
  | 'workspace.cloud_save'
  | 'workspace.cloud_open'
  | 'workspace.share'
  | 'ai.sql'
  | 'ai.sql.accept'
  | 'ai.fix'
  | 'ai.explain'
  | 'ai.analyst.ask'
  | 'ai.analyst.consent';

export interface TelemetryState {
  enabled: boolean;
  counts: Partial<Record<TelemetryEvent, number>>;
}

const EMPTY: TelemetryState = { enabled: false, counts: {} };

/**
 * Cached snapshot plus listeners, so React can read this with
 * `useSyncExternalStore` — which needs a stable object identity between changes,
 * and localStorage hands back a fresh parse every time.
 */
let snapshot: TelemetryState | null = null;
const listeners = new Set<() => void>();

export function subscribeTelemetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTelemetrySnapshot(): TelemetryState {
  snapshot ??= read();
  return snapshot;
}

/** The server has no localStorage, and telemetry is off until proven otherwise. */
export function getTelemetryServerSnapshot(): TelemetryState {
  return EMPTY;
}

function publish(state: TelemetryState): void {
  snapshot = state;
  for (const listener of listeners) listener();
}

function read(): TelemetryState {
  if (typeof localStorage === 'undefined') return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const record = parsed as Partial<TelemetryState>;
    return { enabled: record.enabled === true, counts: record.counts ?? {} };
  } catch {
    return EMPTY;
  }
}

function write(state: TelemetryState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked — telemetry is the first thing that should give
    // way, never the reason an action fails.
  }
}

/** Increment one counter. A no-op unless the user has opted in. */
export function track(event: TelemetryEvent): void {
  const state = getTelemetrySnapshot();
  if (!state.enabled) return;
  const next: TelemetryState = {
    enabled: true,
    counts: { ...state.counts, [event]: (state.counts[event] ?? 0) + 1 },
  };
  write(next);
  publish(next);
}

export function setTelemetryEnabled(enabled: boolean): void {
  // Opting out is also a delete: leaving the counts behind would mean the
  // toggle only stopped collection, which is not what "off" implies.
  const next = enabled ? { ...getTelemetrySnapshot(), enabled: true } : EMPTY;
  write(next);
  publish(next);
}
