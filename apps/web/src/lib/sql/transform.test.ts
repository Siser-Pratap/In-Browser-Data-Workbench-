import { describe, expect, it } from 'vitest';

import type { ColumnSchema } from '@/lib/engine/types';
import {
  compileAggregate,
  compileCastColumn,
  compileDerive,
  compileDropColumn,
  compileFilter,
  compileJoin,
  compileRenameColumn,
  compileReorderColumns,
  compileTransform,
  defaultAlias,
  renderAggregate,
} from './transform';

/**
 * These are golden-string tests on purpose. Transformations are the layer where
 * a subtly wrong query returns plausible-looking numbers instead of an error, so
 * "does the generated SQL still say exactly this?" is the property worth
 * pinning — the SQL is shown to the user, so its exact text is part of the UI.
 */

const columns: ColumnSchema[] = [
  { name: 'id', type: 'BIGINT', kind: 'number' },
  { name: 'name', type: 'VARCHAR', kind: 'string' },
  { name: 'active', type: 'BOOLEAN', kind: 'boolean' },
  { name: 'signed_up', type: 'DATE', kind: 'date' },
];

describe('compileFilter', () => {
  it('returns a plain select when nothing is configured', () => {
    expect(compileFilter({ kind: 'filter', table: 'users', combinator: 'AND', conditions: [] }, columns)).toBe(
      'SELECT * FROM "users"',
    );
  });

  it('leaves numeric comparisons unquoted so they compare as numbers', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [{ column: 'id', operator: '>', value: '10' }],
      },
      columns,
    );
    expect(sql).toBe('SELECT * FROM "users"\nWHERE "id" > 10');
  });

  it('quotes a non-numeric value even on a numeric column, rather than emitting bare junk', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [{ column: 'id', operator: '=', value: 'abc' }],
      },
      columns,
    );
    expect(sql).toBe(`SELECT * FROM "users"\nWHERE "id" = 'abc'`);
  });

  it('renders booleans bare and dates quoted', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [
          { column: 'active', operator: '=', value: 'TRUE' },
          { column: 'signed_up', operator: '>=', value: '2024-01-01' },
        ],
      },
      columns,
    );
    expect(sql).toBe(
      `SELECT * FROM "users"\nWHERE "active" = true\n  AND "signed_up" >= '2024-01-01'`,
    );
  });

  it('joins conditions with the chosen combinator', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'OR',
        conditions: [
          { column: 'name', operator: 'contains', value: 'ada' },
          { column: 'name', operator: 'starts_with', value: 'gr' },
        ],
      },
      columns,
    );
    expect(sql).toBe(
      `SELECT * FROM "users"\nWHERE "name" ILIKE '%ada%'\n  OR "name" ILIKE 'gr%'`,
    );
  });

  it('escapes LIKE wildcards typed as literal characters', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [{ column: 'name', operator: 'contains', value: '50%_off' }],
      },
      columns,
    );
    expect(sql).toBe(`SELECT * FROM "users"\nWHERE "name" ILIKE '%50\\%\\_off%'`);
  });

  it('escapes embedded quotes rather than breaking out of the literal', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [{ column: 'name', operator: '=', value: "O'Hara" }],
      },
      columns,
    );
    expect(sql).toBe(`SELECT * FROM "users"\nWHERE "name" = 'O''Hara'`);
  });

  it('drops conditions with no value, but keeps the unary ones', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [
          { column: 'name', operator: '=', value: '' },
          { column: 'name', operator: 'is_null', value: '' },
        ],
      },
      columns,
    );
    expect(sql).toBe('SELECT * FROM "users"\nWHERE "name" IS NULL');
  });

  it('splits an IN list and types each item', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [{ column: 'id', operator: 'in', value: '1, 2, 3' }],
      },
      columns,
    );
    expect(sql).toBe('SELECT * FROM "users"\nWHERE "id" IN (1, 2, 3)');
  });

  it('emits a matches-nothing IN rather than an empty list, which is a syntax error', () => {
    const sql = compileFilter(
      {
        kind: 'filter',
        table: 'users',
        combinator: 'AND',
        conditions: [{ column: 'id', operator: 'in', value: ' , ' }],
      },
      columns,
    );
    expect(sql).toBe('SELECT * FROM "users"\nWHERE "id" IN (NULL)');
  });
});

describe('compileDerive', () => {
  it('appends the expression as a named column', () => {
    expect(
      compileDerive({ kind: 'derive', table: 'users', name: 'shout', expression: 'upper(name)' }),
    ).toBe('SELECT *,\n  upper(name) AS "shout"\nFROM "users"');
  });
});

describe('compileAggregate', () => {
  it('defaults to counting rows when nothing is chosen', () => {
    expect(compileAggregate({ kind: 'aggregate', table: 'users', groupBy: [], aggregations: [] })).toBe(
      'SELECT count(*) AS "row_count"\nFROM "users"',
    );
  });

  it('builds a grouped summary with derived aliases', () => {
    const sql = compileAggregate({
      kind: 'aggregate',
      table: 'orders',
      groupBy: ['region'],
      aggregations: [
        { fn: 'sum', column: 'total' },
        { fn: 'count_distinct', column: 'customer_id' },
      ],
      orderBy: { column: 'sum_total', descending: true },
      limit: 10,
    });
    expect(sql).toBe(
      'SELECT "region",\n' +
        '       sum("total") AS "sum_total",\n' +
        '       count(DISTINCT "customer_id") AS "count_distinct_customer_id"\n' +
        'FROM "orders"\n' +
        'GROUP BY "region"\n' +
        'ORDER BY "sum_total" DESC\n' +
        'LIMIT 10',
    );
  });

  it('honours an explicit alias', () => {
    const sql = compileAggregate({
      kind: 'aggregate',
      table: 'orders',
      groupBy: [],
      aggregations: [{ fn: 'avg', column: 'total', alias: 'basket size' }],
    });
    expect(sql).toBe('SELECT avg("total") AS "basket size"\nFROM "orders"');
  });

  it('renders count(*) without quoting the star', () => {
    expect(renderAggregate({ fn: 'count', column: '*' })).toBe('count(*)');
    expect(defaultAlias({ fn: 'count', column: '*' })).toBe('row_count');
  });
});

describe('compileJoin', () => {
  it('aliases both sides and joins on the key pairs', () => {
    const sql = compileJoin({
      kind: 'join',
      left: 'orders',
      right: 'users',
      type: 'LEFT',
      keys: [{ left: 'user_id', right: 'id' }],
    });
    expect(sql).toBe(
      'SELECT l.*, r.*\nFROM "orders" AS l\nLEFT JOIN "users" AS r\n  ON l."user_id" = r."id"',
    );
  });

  it('ANDs multiple key pairs', () => {
    const sql = compileJoin({
      kind: 'join',
      left: 'a',
      right: 'b',
      type: 'INNER',
      keys: [
        { left: 'day', right: 'day' },
        { left: 'sku', right: 'sku' },
      ],
    });
    expect(sql).toContain('ON l."day" = r."day"\n  AND l."sku" = r."sku"');
  });

  it('refuses to emit an accidental cartesian product', () => {
    const sql = compileJoin({ kind: 'join', left: 'a', right: 'b', type: 'INNER', keys: [] });
    expect(sql).toContain('-- Pick at least one pair of join keys.');
    expect(sql).not.toContain('JOIN "b"');
  });

  it('allows a cross join when it was asked for explicitly', () => {
    const sql = compileJoin({ kind: 'join', left: 'a', right: 'b', type: 'CROSS', keys: [] });
    expect(sql).toBe('SELECT l.*, r.*\nFROM "a" AS l\nCROSS JOIN "b" AS r');
  });
});

describe('column operations', () => {
  it('renames', () => {
    expect(compileRenameColumn('users', 'name', 'full name')).toBe(
      'ALTER TABLE "users" RENAME COLUMN "name" TO "full name"',
    );
  });

  it('casts through TRY_CAST so one bad row cannot abort the change', () => {
    expect(compileCastColumn('users', 'id', 'VARCHAR')).toBe(
      'ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE VARCHAR USING TRY_CAST("id" AS VARCHAR)',
    );
  });

  it('drops', () => {
    expect(compileDropColumn('users', 'id')).toBe('ALTER TABLE "users" DROP COLUMN "id"');
  });

  it('reorders by rewriting the table', () => {
    expect(compileReorderColumns('users', ['name', 'id'])).toBe(
      'CREATE OR REPLACE TABLE "users" AS SELECT "name", "id" FROM "users"',
    );
  });
});

describe('compileTransform', () => {
  it('dispatches on the spec kind', () => {
    expect(compileTransform({ kind: 'derive', table: 't', name: 'x', expression: '1' })).toContain(
      'AS "x"',
    );
  });
});
