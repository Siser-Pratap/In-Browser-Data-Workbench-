import { describe, expect, it } from 'vitest';

import { isSingleStatement, splitStatements, statementAt } from './statements';

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2').map((s) => s.sql)).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('ignores a trailing semicolon', () => {
    expect(splitStatements('SELECT 1;').map((s) => s.sql)).toEqual(['SELECT 1']);
  });

  it('keeps a semicolon inside a string literal', () => {
    expect(splitStatements(`SELECT 'a;b' AS x`).map((s) => s.sql)).toEqual([`SELECT 'a;b' AS x`]);
  });

  it('keeps a semicolon inside a quoted identifier', () => {
    expect(splitStatements('SELECT "a;b" FROM t').map((s) => s.sql)).toEqual([
      'SELECT "a;b" FROM t',
    ]);
  });

  it('handles a doubled quote as an escape, not a terminator', () => {
    expect(splitStatements(`SELECT 'O''Hara; Ltd' AS x`).map((s) => s.sql)).toEqual([
      `SELECT 'O''Hara; Ltd' AS x`,
    ]);
  });

  it('ignores semicolons in line comments', () => {
    expect(splitStatements('SELECT 1 -- a; b\nFROM t').map((s) => s.sql)).toEqual([
      'SELECT 1 -- a; b\nFROM t',
    ]);
  });

  it('ignores semicolons in block comments', () => {
    expect(splitStatements('SELECT /* a; b */ 1').map((s) => s.sql)).toEqual([
      'SELECT /* a; b */ 1',
    ]);
  });

  it('ignores semicolons in dollar-quoted bodies', () => {
    expect(splitStatements('SELECT $$a;b$$ AS x').map((s) => s.sql)).toEqual(['SELECT $$a;b$$ AS x']);
  });

  it('drops empty statements from stray semicolons', () => {
    expect(splitStatements(';;\nSELECT 1;;').map((s) => s.sql)).toEqual(['SELECT 1']);
  });

  it('reports offsets that span only the statement text', () => {
    const [statement] = splitStatements('  SELECT 1  ;');
    expect(statement).toBeDefined();
    expect('  SELECT 1  ;'.slice(statement!.start, statement!.end)).toBe('SELECT 1');
  });
});

describe('statementAt', () => {
  const buffer = 'SELECT 1;\nSELECT 2;';

  it('finds the statement containing the cursor', () => {
    expect(statementAt(buffer, 3)?.sql).toBe('SELECT 1');
    expect(statementAt(buffer, 14)?.sql).toBe('SELECT 2');
  });

  it('falls back to the last statement when the cursor is past the end', () => {
    expect(statementAt(buffer, buffer.length)?.sql).toBe('SELECT 2');
  });

  it('returns null for an empty buffer', () => {
    expect(statementAt('   ', 0)).toBeNull();
  });
});

describe('isSingleStatement', () => {
  it('is true for one statement with or without a terminator', () => {
    expect(isSingleStatement('SELECT 1')).toBe(true);
    expect(isSingleStatement('SELECT 1;')).toBe(true);
  });

  it('is false once there are two', () => {
    expect(isSingleStatement('SELECT 1; SELECT 2')).toBe(false);
  });
});
