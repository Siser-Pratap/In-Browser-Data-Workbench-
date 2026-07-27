import { describe, expect, it } from 'vitest';

import type { ColumnSchema, QueryResult } from '@/lib/engine/types';
import { alignToCategories, canUseLogScale, shapeChart, SINGLE_SERIES } from './shape';

function result(columnNames: string[], rows: unknown[][]): QueryResult {
  const columns: ColumnSchema[] = columnNames.map((name) => ({
    name,
    type: 'VARCHAR',
    kind: 'string',
  }));
  return { columns, rows, rowCount: rows.length, elapsedMs: 1 };
}

describe('shapeChart', () => {
  it('reads a single unnamed series', () => {
    const shaped = shapeChart(
      result(['x', 'y'], [
        ['North', 10],
        ['South', 20],
      ]),
      8,
    );
    expect(shaped.categories).toEqual(['North', 'South']);
    expect(shaped.series).toEqual([
      { name: SINGLE_SERIES, points: [{ x: 'North', y: 10 }, { x: 'South', y: 20 }] },
    ]);
  });

  it('splits on the series column and ranks by magnitude', () => {
    const shaped = shapeChart(
      result(['x', 'series', 'y'], [
        ['Jan', 'small', 1],
        ['Jan', 'big', 100],
      ]),
      8,
    );
    expect(shaped.series.map((entry) => entry.name)).toEqual(['big', 'small']);
  });

  it('keeps each distinct x once, in query order', () => {
    const shaped = shapeChart(
      result(['x', 'series', 'y'], [
        ['Jan', 'a', 1],
        ['Jan', 'b', 2],
        ['Feb', 'a', 3],
      ]),
      8,
    );
    expect(shaped.categories).toEqual(['Jan', 'Feb']);
  });

  it('folds series past the cap into one "Other" rather than inventing colours', () => {
    const shaped = shapeChart(
      result(['x', 'series', 'y'], [
        ['Jan', 'a', 10],
        ['Jan', 'b', 9],
        ['Jan', 'c', 3],
        ['Jan', 'd', 2],
      ]),
      2,
    );
    expect(shaped.folded).toBe(true);
    expect(shaped.series.map((entry) => entry.name)).toEqual(['a', 'b', 'Other']);
  });

  it('sums the folded tail per category rather than dropping it', () => {
    const shaped = shapeChart(
      result(['x', 'series', 'y'], [
        ['Jan', 'a', 10],
        ['Jan', 'c', 3],
        ['Jan', 'd', 2],
      ]),
      1,
    );
    const other = shaped.series.find((entry) => entry.name === 'Other');
    expect(other?.points).toEqual([{ x: 'Jan', y: 5 }]);
  });

  it('does not fold when the series fit', () => {
    const shaped = shapeChart(result(['x', 'series', 'y'], [['Jan', 'a', 1]]), 8);
    expect(shaped.folded).toBe(false);
  });

  it('treats a NULL series value as the single series, not as the string "null"', () => {
    const shaped = shapeChart(result(['x', 'series', 'y'], [['Jan', null, 1]]), 8);
    expect(shaped.series[0]?.name).toBe(SINGLE_SERIES);
  });

  it('reads a non-numeric measure as null instead of NaN', () => {
    const shaped = shapeChart(result(['x', 'y'], [['Jan', 'not a number']]), 8);
    expect(shaped.series[0]?.points[0]?.y).toBeNull();
  });

  it('carries the size column through for bubbles', () => {
    const shaped = shapeChart(result(['x', 'y', 'size'], [[1, 2, 30]]), 8);
    expect(shaped.series[0]?.points[0]).toEqual({ x: 1, y: 2, size: 30 });
  });
});

describe('alignToCategories', () => {
  it('inserts a gap where a series has no value, rather than shifting later points', () => {
    const aligned = alignToCategories(
      { name: 'a', points: [{ x: 'Jan', y: 1 }, { x: 'Mar', y: 3 }] },
      ['Jan', 'Feb', 'Mar'],
    );
    expect(aligned).toEqual([1, null, 3]);
  });
});

describe('canUseLogScale', () => {
  it('allows a log axis when every value is positive', () => {
    expect(canUseLogScale([{ name: 'a', points: [{ x: 1, y: 5 }] }])).toBe(true);
  });

  it('refuses at zero and below, where a log axis is undefined', () => {
    expect(canUseLogScale([{ name: 'a', points: [{ x: 1, y: 0 }] }])).toBe(false);
    expect(canUseLogScale([{ name: 'a', points: [{ x: 1, y: -2 }] }])).toBe(false);
  });

  it('ignores nulls, which simply are not plotted', () => {
    expect(canUseLogScale([{ name: 'a', points: [{ x: 1, y: null }, { x: 2, y: 4 }] }])).toBe(true);
  });
});
