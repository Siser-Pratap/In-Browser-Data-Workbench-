import { describe, expect, it, vi } from 'vitest';

import type { ToolCallEvent } from '@/lib/api/ai';
import {
  budget,
  cellForModel,
  executeToolCall,
  executeToolCalls,
  MAX_TOOL_RESULT_CHARS,
} from './tools';

const engine = vi.hoisted(() => ({
  catalog: vi.fn(),
  describeTable: vi.fn(),
  countRows: vi.fn(),
  runQuery: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/engine/engine', () => ({ getEngine: () => engine }));
vi.mock('@/lib/ai/profile', () => ({
  buildTableProfile: vi.fn(async (table: string) => ({ version: 1, table, row_count: 1 })),
}));

function call(name: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', tool_use_id: 'tu_1', name, input } as ToolCallEvent;
}

describe('executeToolCall', () => {
  it('returns rows and column names for run_sql', async () => {
    engine.runQuery.mockResolvedValue({
      columns: [{ name: 'region' }, { name: 'n' }],
      rows: [['north', 3]],
      rowCount: 1,
      elapsedMs: 1,
    });
    const result = await executeToolCall(call('run_sql', { sql: 'SELECT 1' }));
    expect(result.is_error).toBe(false);
    expect(result.content).toMatchObject({
      columns: ['region', 'n'],
      rows: [['north', 3]],
      returned_rows: 1,
      truncated: false,
    });
  });

  it('tells the model when a result was capped', async () => {
    // Otherwise the model treats 50 rows as the complete answer and reports a
    // total that is simply wrong.
    engine.runQuery.mockResolvedValue({
      columns: [{ name: 'x' }],
      rows: Array.from({ length: 50 }, (_, i) => [i]),
      rowCount: 50,
      elapsedMs: 1,
      truncated: true,
    });
    const result = await executeToolCall(call('run_sql', { sql: 'SELECT * FROM big' }));
    expect(result.content).toMatchObject({ truncated: true });
    expect(String((result.content as { note: string }).note)).toContain('Aggregate');
  });

  it('reports a CREATE TABLE as success rather than an empty result', async () => {
    // A CTAS returns no columns; "0 rows" reads to the model as a failed query.
    engine.runQuery.mockResolvedValue({ columns: [], rows: [], rowCount: 0, elapsedMs: 1 });
    const onCatalogChanged = vi.fn();
    const result = await executeToolCall(
      call('run_sql', { sql: 'CREATE TABLE t AS SELECT 1' }),
      { onCatalogChanged },
    );
    expect(result.is_error).toBe(false);
    expect(result.content).toMatchObject({ ok: true });
    expect(onCatalogChanged).toHaveBeenCalled();
  });

  it('turns a thrown engine error into an error result, not an exception', async () => {
    // This is the channel the model self-corrects through; throwing would end
    // the conversation instead of prompting a fixed query.
    engine.runQuery.mockRejectedValue(new Error('Binder Error: no such column'));
    const result = await executeToolCall(call('run_sql', { sql: 'SELECT nope' }));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Binder Error');
    expect(result.tool_use_id).toBe('tu_1');
  });

  it('errors on a missing required argument', async () => {
    const result = await executeToolCall(call('run_sql', {}));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('sql');
  });

  it('errors on an unknown tool rather than dying', async () => {
    const result = await executeToolCall(call('drop_everything', {}));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('lists tables with column counts only', async () => {
    engine.catalog.mockResolvedValue([{ name: 'sales', columns: [{ name: 'a' }, { name: 'b' }] }]);
    const result = await executeToolCall(call('list_tables'));
    expect(result.content).toEqual({ tables: [{ name: 'sales', columns: 2 }] });
  });

  it('routes get_profile through the browser profiler', async () => {
    const result = await executeToolCall(call('get_profile', { table: 'sales' }));
    expect(result.content).toMatchObject({ version: 1, table: 'sales' });
  });

  it('hands a chart to the panel and acknowledges', async () => {
    const onChart = vi.fn();
    const result = await executeToolCall(call('create_chart', { type: 'bar' }), { onChart });
    expect(onChart).toHaveBeenCalledWith({ type: 'bar' });
    expect(result.is_error).toBe(false);
  });
});

describe('executeToolCalls', () => {
  it('returns exactly one result per call, including for failures', async () => {
    // The server rejects the whole submission if the returned id set doesn't
    // match what it is waiting for, so a failing tool must still come back.
    engine.catalog.mockResolvedValue([]);
    engine.runQuery.mockRejectedValue(new Error('boom'));
    const results = await executeToolCalls([
      { type: 'tool_call', tool_use_id: 'a', name: 'list_tables', input: {} } as ToolCallEvent,
      { type: 'tool_call', tool_use_id: 'b', name: 'run_sql', input: { sql: 'x' } } as ToolCallEvent,
    ]);
    expect(results.map((result) => result.tool_use_id)).toEqual(['a', 'b']);
    expect(results[1]?.is_error).toBe(true);
  });
});

describe('cellForModel', () => {
  it('converts BigInt, which JSON.stringify throws on', () => {
    expect(cellForModel(10n)).toBe(10);
  });

  it('converts Date to ISO rather than an empty object', () => {
    expect(cellForModel(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('passes JSON scalars through and stringifies everything else', () => {
    expect(cellForModel('a')).toBe('a');
    expect(cellForModel(1.5)).toBe(1.5);
    expect(cellForModel(true)).toBe(true);
    expect(cellForModel(null)).toBeNull();
    expect(cellForModel(undefined)).toBeNull();
    expect(typeof cellForModel({ nested: 1 })).toBe('string');
  });
});

describe('budget', () => {
  it('passes a normal payload through untouched', () => {
    const content = { rows: [[1, 2]] };
    expect(budget(content)).toBe(content);
  });

  it('replaces an oversized payload with an actionable message', () => {
    // Better than letting the server cut the JSON at a fixed character count:
    // the model can act on "too large, aggregate" and cannot act on a syntax
    // error halfway through a string.
    const huge = { rows: [['x'.repeat(MAX_TOOL_RESULT_CHARS + 100)]] };
    const result = budget(huge) as { error: string; note: string };
    expect(result.error).toContain('too large');
    expect(result.note).toContain('Aggregate');
  });

  it('reports unserialisable content instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(budget(circular)).toMatchObject({ error: expect.stringContaining('serialised') });
  });
});
