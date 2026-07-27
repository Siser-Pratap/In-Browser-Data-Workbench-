import { describe, expect, it } from 'vitest';

import { parseSqlError } from './errors';

describe('parseSqlError', () => {
  it('reads the position out of the caret diagram', () => {
    const parsed = parseSqlError(
      new Error(
        'Parser Error: syntax error at or near "SELEC"\nLINE 1: SELEC * FROM t\n        ^',
      ),
    );
    expect(parsed.title).toBe('Syntax error');
    expect(parsed.position).toEqual({ line: 1, column: 1 });
  });

  it('recovers the column inside the printed line, not the printed line itself', () => {
    const parsed = parseSqlError(
      new Error(
        'Binder Error: Referenced column "foo" not found in FROM clause!\n' +
          'LINE 1: SELECT foo FROM t\n' +
          '               ^',
      ),
    );
    // `LINE 1: ` is 8 characters, so a caret at index 15 is column 8.
    expect(parsed.position).toEqual({ line: 1, column: 8 });
  });

  it('strips the caret diagram from the detail it shows', () => {
    const parsed = parseSqlError(
      new Error('Parser Error: syntax error\nLINE 1: SELEC 1\n        ^'),
    );
    expect(parsed.detail).toBe('syntax error');
  });

  it('suggests the candidate bindings DuckDB already worked out', () => {
    const parsed = parseSqlError(
      new Error(
        'Binder Error: Referenced column "nme" not found in FROM clause!\nCandidate bindings: "name"',
      ),
    );
    expect(parsed.hint).toBe('Did you mean "name"?');
  });

  it('points at the sidebar for a missing table', () => {
    const parsed = parseSqlError(
      new Error('Catalog Error: Table with name orders does not exist!'),
    );
    expect(parsed.title).toBe('Unknown table or function');
    expect(parsed.hint).toContain('sidebar');
  });

  it('explains the browser memory budget on OOM', () => {
    const parsed = parseSqlError(new Error('Out of Memory Error: failed to allocate'));
    expect(parsed.title).toBe('Out of memory');
    expect(parsed.hint).toContain('LIMIT');
  });

  it('suggests TRY_CAST on a conversion failure', () => {
    const parsed = parseSqlError(
      new Error('Conversion Error: Could not convert string \'x\' to INT32'),
    );
    expect(parsed.hint).toContain('TRY_CAST');
  });

  it('degrades gracefully for anything that is not a DuckDB error', () => {
    const parsed = parseSqlError('the engine is not ready yet');
    expect(parsed).toEqual({
      title: 'Query failed',
      detail: 'the engine is not ready yet',
      position: null,
      hint: null,
    });
  });
});
