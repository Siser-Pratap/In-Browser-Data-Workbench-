/**
 * The HTTP client every cloud call goes through.
 *
 * Three things live here that would otherwise be duplicated at every call site:
 *
 * **The access token never touches storage.** It's a module-level variable and
 * nothing more. The refresh token is an httpOnly cookie the JS can't read, so a
 * reload re-establishes the session by calling `/auth/refresh` rather than by
 * reading a token out of `localStorage`. That costs one request on boot and
 * removes the XSS-exfiltration path entirely — the right trade for a product
 * whose whole pitch is that your data stays yours.
 *
 * **A 401 refreshes once and retries.** Access tokens are short-lived by
 * design, so without this every long session would start failing mid-use. The
 * in-flight refresh is shared (`refreshing`) because a page load fires several
 * requests at once and they must not each rotate the refresh token — rotation
 * invalidates the previous one, so concurrent refreshes would log the user out.
 *
 * **Errors arrive as `ApiError`.** Callers get problem+json fields, not a
 * `Response` they have to unpack.
 */

import { API_PREFIX, apiBaseUrl, apiConfigured } from './config';
import { ApiError, offlineError, toApiError } from './problem';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
/** Notified whenever the session ends, so stores can reset. */
const listeners = new Set<() => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Register a callback for "the session is gone". Returns an unsubscribe. */
export function onSessionLost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sessionLost(): void {
  accessToken = null;
  for (const listener of listeners) listener();
}

export function apiUrl(path: string): string {
  return `${apiBaseUrl()}${API_PREFIX}${path}`;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Extra headers; `Authorization` and `Content-Type` are handled here. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip the 401→refresh→retry dance (used by the auth calls themselves). */
  noRetry?: boolean;
  /** Send no `Authorization` even if a token exists (public share reads). */
  anonymous?: boolean;
}

/** Build the fetch init, so `request` and `stream` agree on the details. */
export function buildInit(options: RequestOptions): RequestInit {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken && !options.anonymous) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  return {
    method: options.method ?? 'GET',
    headers,
    // The refresh cookie is httpOnly and cross-origin (:3000 -> :8000), so it
    // only travels when credentials are included *and* the API names this
    // origin explicitly in CORS — `*` is rejected with credentials.
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  };
}

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Returns false rather than throwing when there's no valid session — "not
 * signed in" is an ordinary state on this app, not an error.
 */
export async function refreshSession(): Promise<boolean> {
  if (!apiConfigured()) return false;
  refreshing ??= (async () => {
    try {
      const response = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { access_token?: string };
      if (!body.access_token) return false;
      accessToken = body.access_token;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared in `finally` so a failed refresh doesn't latch and block every
      // later attempt for the life of the page.
      refreshing = null;
    }
  })();
  return refreshing;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  try {
    return await fetch(apiUrl(path), buildInit(options));
  } catch (cause) {
    // An aborted request is the caller's own doing — surface it as-is so
    // `AbortError` checks work rather than turning it into "server unreachable".
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw offlineError(cause);
  }
}

/**
 * Send, and on a 401 refresh once and send again.
 *
 * The single place that policy lives — `request`, `requestWithResponse` and
 * `stream` all route through it, so none of them can drift into a slightly
 * different idea of when a session is over.
 */
async function sendWithRetry(path: string, options: RequestOptions): Promise<Response> {
  if (!apiConfigured()) {
    throw new ApiError(0, { title: 'No API is configured for this build.' });
  }

  const response = await send(path, options);
  if (response.status !== 401 || options.noRetry || options.anonymous) return response;

  if (!(await refreshSession())) {
    sessionLost();
    return response;
  }

  // A retry that still comes back 401 means the refresh produced a token the
  // API won't accept — the session is over even though the refresh "worked",
  // so say so rather than leaving the UI signed in over failing requests.
  const retried = await send(path, options);
  if (retried.status === 401) sessionLost();
  return retried;
}

/**
 * Perform a request, refreshing once on 401.
 *
 * `T` is asserted, not validated. The types come from the server's own OpenAPI
 * schema (`schema.ts`), so the contract is checked at build time where it can
 * actually be fixed, rather than re-litigated at runtime on every response.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { data } = await requestWithResponse<T>(path, options);
  return data;
}

/**
 * Like `request`, but hands back the `Response` so callers can read headers.
 *
 * The snapshot endpoints need the `ETag`, which is the whole basis of the
 * optimistic-concurrency check — so it can't be thrown away with the body.
 */
export async function requestWithResponse<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; response: Response }> {
  const response = await sendWithRetry(path, options);
  if (!response.ok) throw await toApiError(response);

  // 204 and an empty 200 both mean "no body"; `.text()` gives '' for each.
  const text = await response.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, response };
}

/**
 * Open a streaming POST, refreshing once on 401.
 *
 * `EventSource` can't do this: the AI endpoints are POSTs with a JSON body and
 * a bearer token, and `EventSource` supports neither. So SSE rides on `fetch`
 * and `sse.ts` does the framing.
 */
export async function stream(path: string, options: RequestOptions = {}): Promise<Response> {
  const response = await sendWithRetry(path, {
    ...options,
    // After the spread, not before: every AI endpoint is a POST, and a caller
    // that happened to pass `method: undefined` would otherwise silently
    // downgrade the request to GET.
    method: options.method ?? 'POST',
    headers: { Accept: 'text/event-stream', ...options.headers },
  });

  if (!response.ok) throw await toApiError(response);
  return response;
}
