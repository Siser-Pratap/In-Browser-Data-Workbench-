import { describe, expect, it } from 'vitest';

import type { SqlStreamEvent } from '@/lib/api/ai';
import { reduce } from './useSqlStream';

const EMPTY = {
  text: '',
  sql: null,
  explanation: null,
  clarification: null,
  error: null,
  running: true,
  finished: false,
};

function fold(events: SqlStreamEvent[]) {
  return events.reduce(reduce, EMPTY);
}

describe('reduce', () => {
  it('accumulates deltas in order', () => {
    const state = fold([
      { type: 'delta', text: 'SELECT ' },
      { type: 'delta', text: '1' },
    ] as SqlStreamEvent[]);
    expect(state.text).toBe('SELECT 1');
  });

  it('captures the sql event and its explanation', () => {
    const state = fold([
      { type: 'delta', text: 'thinking' },
      { type: 'sql', sql: 'SELECT 1', explanation: 'Returns one.', corrected: false },
      { type: 'done' },
    ] as SqlStreamEvent[]);
    expect(state.sql).toBe('SELECT 1');
    expect(state.explanation).toBe('Returns one.');
    expect(state.finished).toBe(true);
  });

  it('keeps an earlier explanation when the sql event carries none', () => {
    const state = fold([
      { type: 'explanation', text: 'Groups by region.' },
      { type: 'sql', sql: 'SELECT 1', explanation: null, corrected: false },
    ] as SqlStreamEvent[]);
    expect(state.explanation).toBe('Groups by region.');
  });

  it('records a clarification instead of sql', () => {
    const state = fold([
      { type: 'clarification', question: 'Which date column?' },
      { type: 'done' },
    ] as SqlStreamEvent[]);
    expect(state.clarification).toBe('Which date column?');
    expect(state.sql).toBeNull();
  });

  it('surfaces the error message', () => {
    const state = fold([
      { type: 'error', code: 'not_configured', message: 'AI is not configured.' },
    ] as SqlStreamEvent[]);
    expect(state.error).toBe('AI is not configured.');
  });

  it('falls back to a message when the server sends an empty one', () => {
    const state = fold([{ type: 'error', code: 'x', message: '' }] as SqlStreamEvent[]);
    expect(state.error).toBe('The AI request failed.');
  });

  it('ignores event types it does not model', () => {
    const state = fold([{ type: 'usage', usage: {} }] as unknown as SqlStreamEvent[]);
    expect(state).toEqual(EMPTY);
  });
});
