import { describe, expect, it } from 'vitest';

import { readerExpression } from './engine';

/**
 * The reader expression is what turns a registered file into a table. It's
 * pure string-building, so it's tested without booting DuckDB — the WASM engine
 * itself is exercised by the Playwright smoke test.
 */
describe('readerExpression', () => {
  const base = { table: 't' } as const;

  it('reads parquet by path', () => {
    expect(readerExpression('file.parquet', { ...base, format: 'parquet' })).toBe(
      "read_parquet('file.parquet')",
    );
  });

  it('reads json with the auto reader', () => {
    expect(readerExpression('file.json', { ...base, format: 'json' })).toBe(
      "read_json_auto('file.json')",
    );
  });

  it('reads csv with auto-detect on', () => {
    const sql = readerExpression('file.csv', { ...base, format: 'csv' });
    expect(sql).toContain('read_csv(');
    expect(sql).toContain('auto_detect=true');
  });

  it('passes an explicit delimiter and header through', () => {
    const sql = readerExpression('file.csv', {
      ...base,
      format: 'csv',
      delimiter: ';',
      hasHeader: false,
    });
    expect(sql).toContain("delim=';'");
    expect(sql).toContain('header=false');
  });

  it('defaults a tsv to a tab delimiter', () => {
    expect(readerExpression('file.tsv', { ...base, format: 'tsv' })).toContain("delim='\t'");
  });

  it('escapes a single quote in the virtual path', () => {
    // A registered name derived from a filename could contain a quote; it must
    // not break out of the literal.
    const sql = readerExpression("o'brien.parquet", { ...base, format: 'parquet' });
    expect(sql).toBe("read_parquet('o''brien.parquet')");
  });

  it('refuses to build a reader for xlsx (handled by importJsonRows)', () => {
    expect(() => readerExpression('file.xlsx', { ...base, format: 'xlsx' })).toThrow();
  });
});
