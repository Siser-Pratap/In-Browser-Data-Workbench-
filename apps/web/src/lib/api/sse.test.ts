import { describe, expect, it } from 'vitest';

import { parseFrame, readSse, splitFrames } from './sse';

describe('splitFrames', () => {
  it('returns complete frames and keeps the remainder', () => {
    const { frames, rest } = splitFrames('data: a\n\ndata: b\n\ndata: par');
    expect(frames).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('data: par');
  });

  it('returns nothing when no frame is terminated yet', () => {
    const { frames, rest } = splitFrames('data: {"type":"del');
    expect(frames).toEqual([]);
    expect(rest).toBe('data: {"type":"del');
  });

  it('normalises CRLF so values do not keep a stray carriage return', () => {
    const { frames } = splitFrames('data: a\r\n\r\n');
    expect(frames).toEqual(['data: a']);
    expect(parseFrame(frames[0]!)).toBe('a');
  });
});

describe('parseFrame', () => {
  it('strips exactly one leading space', () => {
    expect(parseFrame('data:  two spaces')).toBe(' two spaces');
  });

  it('joins multiple data lines with newlines', () => {
    expect(parseFrame('data: one\ndata: two')).toBe('one\ntwo');
  });

  it('ignores comments and non-data fields', () => {
    expect(parseFrame(': keep-alive')).toBeNull();
    expect(parseFrame('event: ping\nid: 1')).toBeNull();
  });
});

/** A Response whose body streams the given chunks, split exactly as given. */
function streamed(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

describe('readSse', () => {
  it('decodes events that arrive whole', async () => {
    const events = [];
    for await (const event of readSse(
      streamed(['data: {"type":"delta","text":"hi"}\n\ndata: {"type":"done"}\n\n']),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'delta', text: 'hi' }, { type: 'done' }]);
  });

  it('reassembles an event split across chunks', async () => {
    // The case that silently works against a fast local server and corrupts
    // over a real connection, which is why it is pinned here.
    const events = [];
    for await (const event of readSse(
      streamed(['data: {"type":"del', 'ta","text":"split"}', '\n\n']),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'delta', text: 'split' }]);
  });

  it('yields a trailing event that never got its blank line', async () => {
    const events = [];
    for await (const event of readSse(streamed(['data: {"type":"done"}']))) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('skips malformed frames rather than aborting the stream', async () => {
    const events = [];
    for await (const event of readSse(
      streamed(['data: not json\n\ndata: {"type":"done"}\n\n']),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('skips JSON that carries no event type', async () => {
    const events = [];
    for await (const event of readSse(streamed(['data: {"text":"no type"}\n\n']))) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });
});
