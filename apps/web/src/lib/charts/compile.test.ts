import { describe, expect, it } from 'vitest';

import type { ColumnSchema } from '@/lib/engine/types';
import { ChartCompileError, compileChart, filtersFor } from './compile';
import { DEFAULT_OPTIONS, inferSpec, type ChartSpec } from './spec';

function spec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    version: 1,
    id: 'c1',
    type: 'bar',
    query: 'SELECT * FROM orders',
    encoding: { x: 'region', y: 'total', aggregate: 'sum', series: null, size: null },
    options: { ...DEFAULT_OPTIONS },
    ...overrides,
  };
}

describe('compileChart', () => {
  it('aggregates in SQL and orders by the measure', () => {
    expect(compileChart(spec())).toBe(
      'WITH source AS (\n' +
        '  SELECT * FROM orders\n' +
        ')\n' +
        'SELECT "region" AS "x",\n' +
        '       sum("total") AS "y"\n' +
        'FROM source\n' +
        'GROUP BY 1\n' +
        'ORDER BY "y" DESC\n' +
        'LIMIT 50',
    );
  });

  it('adds a series column and groups by it too', () => {
    const sql = compileChart(
      spec({ encoding: { x: 'region', y: 'total', aggregate: 'sum', series: 'category', size: null } }),
    );
    expect(sql).toContain('"category"::VARCHAR AS "series"');
    expect(sql).toContain('GROUP BY 1, 2');
  });

  it('orders a line chart by time, not by magnitude', () => {
    const sql = compileChart(
      spec({ type: 'line', encoding: { x: 'day', y: 'total', aggregate: 'sum', series: null, size: null } }),
    );
    expect(sql).toContain('ORDER BY "x"');
    expect(sql).not.toContain('ORDER BY "y"');
  });

  it('omits GROUP BY when no aggregation was chosen', () => {
    const sql = compileChart(
      spec({ encoding: { x: 'region', y: 'total', aggregate: 'none', series: null, size: null } }),
    );
    expect(sql).not.toContain('GROUP BY');
    expect(sql).toContain('"total" AS "y"');
  });

  it('samples a scatter rather than taking the first N rows', () => {
    const sql = compileChart(
      spec({
        type: 'scatter',
        encoding: { x: 'quantity', y: 'total', aggregate: 'none', series: null, size: null },
        options: { ...DEFAULT_OPTIONS, limit: 5000 },
      }),
    );
    expect(sql).toContain('USING SAMPLE 5000 ROWS');
    expect(sql).not.toContain('GROUP BY');
  });

  it('caps a scatter at the raw-point ceiling however big the limit is', () => {
    const sql = compileChart(
      spec({
        type: 'scatter',
        encoding: { x: 'a', y: 'b', aggregate: 'none', series: null, size: null },
        options: { ...DEFAULT_OPTIONS, limit: 999_999 },
      }),
    );
    expect(sql).toContain('USING SAMPLE 10000 ROWS');
  });

  it('buckets a histogram in one statement', () => {
    const sql = compileChart(
      spec({
        type: 'histogram',
        encoding: { x: 'total', y: null, aggregate: 'none', series: null, size: null },
        options: { ...DEFAULT_OPTIONS, bins: 20 },
      }),
    );
    expect(sql).toContain('bounds AS (SELECT min("total") AS lo, max("total") AS hi FROM source)');
    expect(sql).toContain('width_bucket(source."total", bounds.lo, bounds.hi, 20)');
    expect(sql).toContain('WHERE source."total" IS NOT NULL');
  });

  it('clamps an absurd bin count instead of generating invalid SQL', () => {
    const sql = compileChart(
      spec({
        type: 'histogram',
        encoding: { x: 'total', y: null, aggregate: 'none', series: null, size: null },
        options: { ...DEFAULT_OPTIONS, bins: 100_000 },
      }),
    );
    expect(sql).toContain(', 200)');
  });

  it('reduces a KPI to a single scalar', () => {
    const sql = compileChart(
      spec({
        type: 'kpi',
        encoding: { x: null, y: 'total', aggregate: 'avg', series: null, size: null },
      }),
    );
    expect(sql).toBe(
      'WITH source AS (\n  SELECT * FROM orders\n)\nSELECT avg("total") AS "y"\nFROM source',
    );
  });

  it('strips a trailing semicolon, which would be a syntax error inside the CTE', () => {
    expect(compileChart(spec({ query: 'SELECT * FROM orders;' }))).toContain(
      '  SELECT * FROM orders\n)',
    );
  });

  it('explains what is missing rather than emitting broken SQL', () => {
    expect(() =>
      compileChart(spec({ encoding: { x: null, y: 'total', aggregate: 'sum', series: null, size: null } })),
    ).toThrow(ChartCompileError);
  });

  describe('dashboard filters', () => {
    it('injects an equality filter', () => {
      const sql = compileChart(spec(), [{ kind: 'equals', column: 'region', value: 'North' }]);
      expect(sql).toContain(`WHERE "region" = 'North'`);
    });

    it('injects a date range', () => {
      const sql = compileChart(spec(), [
        { kind: 'date-range', column: 'order_date', from: '2024-01-01', to: '2024-12-31' },
      ]);
      expect(sql).toContain(
        `WHERE "order_date" BETWEEN '2024-01-01'::TIMESTAMP AND '2024-12-31'::TIMESTAMP`,
      );
    });

    it('ANDs several filters', () => {
      const sql = compileChart(spec(), [
        { kind: 'equals', column: 'region', value: 'North' },
        { kind: 'equals', column: 'category', value: 'Software' },
      ]);
      expect(sql).toContain(`WHERE "region" = 'North'\n  AND "category" = 'Software'`);
    });

    it('escapes a quote in a filter value', () => {
      const sql = compileChart(spec(), [{ kind: 'equals', column: 'name', value: "O'Hara" }]);
      expect(sql).toContain(`'O''Hara'`);
    });

    it('filters a histogram through its bounds subquery too, so the axis matches', () => {
      const sql = compileChart(
        spec({
          type: 'histogram',
          encoding: { x: 'total', y: null, aggregate: 'none', series: null, size: null },
        }),
        [{ kind: 'equals', column: 'region', value: 'North' }],
      );
      expect(sql).toContain(`FROM source\nWHERE "region" = 'North')`);
    });
  });
});

describe('filtersFor', () => {
  it('keeps only filters the chart can actually apply', () => {
    const kept = filtersFor(
      [
        { kind: 'equals', column: 'region', value: 'North' },
        { kind: 'equals', column: 'country', value: 'Spain' },
      ],
      ['region', 'total'],
    );
    expect(kept).toEqual([{ kind: 'equals', column: 'region', value: 'North' }]);
  });
});

describe('inferSpec', () => {
  const column = (name: string, kind: ColumnSchema['kind']): ColumnSchema => ({
    name,
    type: kind.toUpperCase(),
    kind,
  });

  it('picks a line for a temporal axis', () => {
    const inferred = inferSpec('c', 'SELECT 1', [column('day', 'date'), column('total', 'number')]);
    expect(inferred.type).toBe('line');
    expect(inferred.encoding.x).toBe('day');
    expect(inferred.encoding.y).toBe('total');
  });

  it('picks a bar for a category plus a number', () => {
    const inferred = inferSpec('c', 'SELECT 1', [
      column('region', 'string'),
      column('total', 'number'),
    ]);
    expect(inferred.type).toBe('bar');
  });

  it('picks a scatter for two numbers', () => {
    const inferred = inferSpec('c', 'SELECT 1', [
      column('quantity', 'number'),
      column('total', 'number'),
    ]);
    expect(inferred.type).toBe('scatter');
    expect(inferred.encoding.aggregate).toBe('none');
  });

  it('picks a big number for a lone measure, not a one-bar bar chart', () => {
    const inferred = inferSpec('c', 'SELECT 1', [column('total', 'number')]);
    expect(inferred.type).toBe('kpi');
  });

  it('falls back to a table when there is nothing numeric', () => {
    const inferred = inferSpec('c', 'SELECT 1', [
      column('region', 'string'),
      column('name', 'string'),
    ]);
    expect(inferred.type).toBe('table');
  });

  it('gives a time series room for more points than a ranking', () => {
    const line = inferSpec('c', 'SELECT 1', [column('day', 'date'), column('total', 'number')]);
    const bar = inferSpec('c', 'SELECT 1', [column('region', 'string'), column('total', 'number')]);
    expect(line.options.limit).toBeGreaterThan(bar.options.limit);
  });

  it('always produces SQL that compiles', () => {
    const inferred = inferSpec('c', 'SELECT * FROM orders', [
      column('region', 'string'),
      column('total', 'number'),
    ]);
    expect(() => compileChart(inferred)).not.toThrow();
  });
});
