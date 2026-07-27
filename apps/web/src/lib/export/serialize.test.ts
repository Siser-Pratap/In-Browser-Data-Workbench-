import { describe, expect, it } from 'vitest';

import type { ColumnSchema } from '@/lib/engine/types';
import { cellText, toCsv, toMarkdown, toTsv } from './serialize';

const columns: ColumnSchema[] = [
  { name: 'name', type: 'VARCHAR', kind: 'string' },
  { name: 'total', type: 'DOUBLE', kind: 'number' },
];

describe('toCsv', () => {
  it('writes a header and rows', () => {
    expect(toCsv(columns, [['ada', 3]])).toBe('name,total\nada,3');
  });

  it('quotes fields containing the delimiter', () => {
    expect(toCsv(columns, [['Lovelace, Ada', 3]])).toBe('name,total\n"Lovelace, Ada",3');
  });

  it('doubles embedded quotes', () => {
    expect(toCsv(columns, [['say "hi"', 1]])).toBe('name,total\n"say ""hi""",1');
  });

  it('quotes fields containing a newline', () => {
    expect(toCsv(columns, [['a\nb', 1]])).toBe('name,total\n"a\nb",1');
  });

  it('writes NULL as an empty field', () => {
    expect(toCsv(columns, [[null, 1]])).toBe('name,total\n,1');
  });
});

describe('toMarkdown', () => {
  it('right-aligns numeric columns', () => {
    expect(toMarkdown(columns, [['ada', 3]])).toBe(
      '| name | total |\n| :--- | ---: |\n| ada | 3 |',
    );
  });

  it('escapes pipes so the table does not break', () => {
    expect(toMarkdown(columns, [['a|b', 1]])).toContain('| a\\|b | 1 |');
  });

  it('flattens newlines, which Markdown tables cannot contain', () => {
    expect(toMarkdown(columns, [['a\nb', 1]])).toContain('| a b | 1 |');
  });
});

describe('toTsv', () => {
  it('replaces tabs and newlines so columns stay aligned', () => {
    expect(toTsv(columns, [['a\tb\nc', 1]])).toBe('name\ttotal\na b c\t1');
  });
});

describe('cellText', () => {
  it('maps null and undefined to empty text', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });

  it('keeps a zero rather than treating it as empty', () => {
    expect(cellText(0)).toBe('0');
  });
});
