/**
 * Short unique ids for tabs, snippets, charts and dashboard items.
 *
 * `crypto.randomUUID` is the right source but isn't available on insecure
 * origins in some browsers, and these ids are local record keys — not security
 * tokens — so a timestamp-plus-randomness fallback is fine.
 */
export function newId(prefix = ''): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${id}` : id;
}
