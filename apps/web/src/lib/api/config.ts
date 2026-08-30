/**
 * Where the API lives, and whether there is one at all.
 *
 * The workbench is local-first: every cloud feature is additive, and the app
 * must stay fully usable when `NEXT_PUBLIC_API_URL` is unset. So this module
 * answers two questions — the base URL, and `apiConfigured`, which every cloud
 * surface checks before it renders itself. An unset API doesn't produce failing
 * requests or dead buttons; the features simply aren't there.
 *
 * Read through a function rather than exported as a constant because Next
 * inlines `process.env.NEXT_PUBLIC_*` at build time, and the tests need to be
 * able to point the client somewhere else.
 */

/** Trailing slashes would produce `//api/v1/...` once joined. */
function normalise(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

const BUILD_TIME_URL = normalise(process.env.NEXT_PUBLIC_API_URL ?? '');

let override: string | null = null;

export function apiBaseUrl(): string {
  return override ?? BUILD_TIME_URL;
}

/**
 * Whether cloud features should appear at all.
 *
 * This is the single gate. If it's false the app is exactly the anonymous
 * workbench it was before any of this existed.
 */
export function apiConfigured(): boolean {
  return apiBaseUrl().length > 0;
}

/** Point the client elsewhere. Tests only. */
export function setApiBaseUrl(url: string | null): void {
  override = url === null ? null : normalise(url);
}

export const API_PREFIX = '/api/v1';
