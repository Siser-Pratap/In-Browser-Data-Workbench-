import { describe, expect, it } from 'vitest';

import type { CatalogTable } from '@/lib/engine/types';
import { completionsFor, identifier, resolveAliases } from './completion';

const catalog: CatalogTable[] = [
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'BIGINT', kind: 'number' },
      { name: 'user_id', type: 'BIGINT', kind: 'number' },
      { name: 'total', type: 'DOUBLE', kind: 'number' },
    ],
  },
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'BIGINT', kind: 'number' },
      { name: 'full name', type: 'VARCHAR', kind: 'string' },
    ],
  },
];

describe('completionsFor', () => {
  it('offers tables, columns, keywords and functions with no qualifier', () => {
    const kinds = new Set(
      completionsFor({ sql: 'SELECT ', offset: 7, catalog }).map((item) => item.kind),
    );
    expect(kinds).toEqual(new Set(['table', 'column', 'keyword', 'function']));
  });

  it('ranks schema items above keywords', () => {
    const items = completionsFor({ sql: 'SELECT ', offset: 7, catalog });
    const table = items.find((item) => item.label === 'orders');
    const keyword = items.find((item) => item.label === 'WHERE');
    expect(table!.rank).toBeLessThan(keyword!.rank);
  });

  it('narrows to one table after a qualifier', () => {
    const items = completionsFor({ sql: 'SELECT users.', offset: 13, catalog });
    expect(items.map((item) => item.label)).toEqual(['id', 'full name']);
    expect(items.every((item) => item.kind === 'column')).toBe(true);
  });

  // The alias is declared to the *right* of the cursor here on purpose: typing
  // `SELECT o.` before finishing the FROM clause is the normal writing order,
  // and it only works because aliases are read from the whole buffer.
  it('resolves a table alias declared after the cursor', () => {
    const items = completionsFor({
      sql: 'SELECT o. FROM orders AS o',
      offset: 'SELECT o.'.length,
      catalog,
    });
    expect(items.map((item) => item.label)).toEqual(['id', 'user_id', 'total']);
  });

  it('resolves an alias written without AS', () => {
    const items = completionsFor({
      sql: 'SELECT u. FROM users u',
      offset: 'SELECT u.'.length,
      catalog,
    });
    expect(items.map((item) => item.label)).toEqual(['id', 'full name']);
  });

  it('completes a partially typed qualified column', () => {
    const items = completionsFor({ sql: 'SELECT orders.tot', offset: 17, catalog });
    expect(items.map((item) => item.label)).toContain('total');
  });

  it('returns nothing for an unknown qualifier rather than falling back to everything', () => {
    expect(completionsFor({ sql: 'SELECT nope.', offset: 12, catalog })).toEqual([]);
  });

  it('lists every table a shared column name appears in', () => {
    const id = completionsFor({ sql: 'SELECT ', offset: 7, catalog }).find(
      (item) => item.kind === 'column' && item.label === 'id',
    );
    expect(id?.detail).toBe('BIGINT · orders, users');
  });

  it('includes saved snippets when they are supplied', () => {
    const items = completionsFor({
      sql: '', offset: 0,
      catalog,
      snippets: [{ name: 'top orders', sql: 'SELECT * FROM orders ORDER BY total DESC' }],
    });
    const snippet = items.find((item) => item.kind === 'snippet');
    expect(snippet?.insertText).toContain('ORDER BY total DESC');
  });
});

describe('resolveAliases', () => {
  it('does not mistake a following keyword for an alias', () => {
    const aliases = resolveAliases('SELECT * FROM orders WHERE total > 1', catalog);
    expect(aliases.get('where')).toBeUndefined();
  });

  it('picks up aliases on both sides of a join', () => {
    const aliases = resolveAliases('FROM orders o LEFT JOIN users AS u ON o.user_id = u.id', catalog);
    expect(aliases.get('o')).toBe('orders');
    expect(aliases.get('u')).toBe('users');
  });
});

describe('identifier', () => {
  it('leaves a plain lowercase name alone', () => {
    expect(identifier('total')).toBe('total');
  });

  it('quotes names with spaces, capitals or reserved words', () => {
    expect(identifier('full name')).toBe('"full name"');
    expect(identifier('Total')).toBe('"Total"');
    expect(identifier('select')).toBe('"select"');
  });

  it('doubles embedded quotes', () => {
    expect(identifier('a"b')).toBe('"a""b"');
  });
});
