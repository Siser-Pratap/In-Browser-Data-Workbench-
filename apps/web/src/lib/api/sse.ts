/**
 * Server-Sent Events over `fetch`.
 *
 * The AI endpoints stream, and they're POSTs carrying a JSON body and a bearer
 * token — none of which `EventSource` supports. So the transport is a plain
 * `fetch` whose body we frame ourselves.
 *
 * The framing is the fiddly part and the reason this is its own module with its
 * own tests: a network chunk has no relationship to an event boundary. One
 * chunk may hold three events, or half of one, or a `\n` whose partner `\n`
 * arrives in the next read. Anything that parses per-chunk instead of
 * maintaining a buffer works perfectly against a fast local server and corrupts
 * events over a real connection.
 */

/** What the backend puts on the wire: `data: {json}\n\n` (see ai/router.py). */
export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Split a growing buffer into complete SSE records.
 *
 * Returns the records that are fully terminated plus whatever tail is left
 * over, which the caller carries into the next chunk. Exported for its tests —
 * this is the logic worth pinning.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  // Normalise CRLF first: the spec allows it and some proxies rewrite line
  // endings, which would otherwise leave a stray \r on every parsed value.
  const normalised = buffer.replace(/\r\n/g, '\n');
  let start = 0;
  for (;;) {
    const boundary = normalised.indexOf('\n\n', start);
    if (boundary === -1) break;
    frames.push(normalised.slice(start, boundary));
    start = boundary + 2;
  }
  return { frames, rest: normalised.slice(start) };
}

/**
 * Pull the payload out of one record.
 *
 * A record may carry `event:`/`id:`/`:comment` lines too; only `data:` matters
 * here, and multiple `data:` lines concatenate with newlines per the spec.
 * Returns null for a record with no data (a keep-alive comment).
 */
export function parseFrame(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    // Exactly one optional leading space is part of the framing, not the value.
    parts.push(line.slice(5).replace(/^ /, ''));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Read a streamed response as decoded events.
 *
 * Malformed JSON is skipped rather than thrown: one bad frame shouldn't abort a
 * turn that is otherwise streaming fine, and the `error`/`done` events that
 * matter are generated server-side and well-formed.
 */
export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const payload = parseFrame(frame);
        if (payload === null) continue;
        const event = decode(payload);
        if (event) yield event;
      }
    }

    // A stream that ends without a trailing blank line still has one event in
    // the buffer; dropping it would silently lose the final `done`.
    buffer += decoder.decode();
    const payload = parseFrame(buffer);
    if (payload !== null) {
      const event = decode(payload);
      if (event) yield event;
    }
  } finally {
    // Cancelling the reader is what actually closes the HTTP connection when a
    // caller breaks out early (the user pressing Stop). Without it the server
    // keeps generating — and keeps spending tokens — for nobody.
    await reader.cancel().catch(() => undefined);
  }
}

function decode(payload: string): SseEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && typeof (parsed as SseEvent).type === 'string') {
      return parsed as SseEvent;
    }
  } catch {
    // Skip: see the note above.
  }
  return null;
}
