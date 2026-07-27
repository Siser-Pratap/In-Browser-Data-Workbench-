import { describe, expect, it } from 'vitest';

import { sniffCsv, splitLine } from './csv';

describe('splitLine', () => {
  it('splits on the delimiter', () => {
    expect(splitLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });

  it('respects quoted fields containing the delimiter', () => {
    expect(splitLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(splitLine('"she said ""hi""",next', ',')).toEqual(['she said "hi"', 'next']);
  });

  it('handles tabs as a delimiter', () => {
    expect(splitLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c']);
  });
});

describe('sniffCsv', () => {
  it('detects a comma delimiter and a header', () => {
    const result = sniffCsv('name,age,city\nAlice,30,NYC\nBob,25,LA');
    expect(result.delimiter).toBe(',');
    expect(result.hasHeader).toBe(true);
    expect(result.preview[0]).toEqual(['name', 'age', 'city']);
  });

  it('prefers the delimiter that splits most consistently, not most often', () => {
    // Commas appear in the prose, but the pipe is the real delimiter: every
    // row has exactly three pipe-separated fields.
    const sample = 'a|b, with comma|c\nd|e, also comma|f\ng|h, too|i';
    expect(sniffCsv(sample).delimiter).toBe('|');
  });

  it('detects a tab-separated file', () => {
    expect(sniffCsv('id\tval\n1\t2\n3\t4').delimiter).toBe('\t');
  });

  it('treats an all-text first row over numeric data as a header', () => {
    expect(sniffCsv('label,count\nx,10\ny,20').hasHeader).toBe(true);
  });

  it('does not call a numeric first row a header', () => {
    expect(sniffCsv('1,2,3\n4,5,6').hasHeader).toBe(false);
  });

  it('returns empty for blank input', () => {
    expect(sniffCsv('').preview).toEqual([]);
  });
});
