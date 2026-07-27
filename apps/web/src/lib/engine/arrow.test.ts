import { describe, expect, it } from 'vitest';

import { normalizeValue } from './arrow';

describe('normalizeValue', () => {
  it('passes primitives through', () => {
    expect(normalizeValue('hello')).toBe('hello');
    expect(normalizeValue(42)).toBe(42);
    expect(normalizeValue(true)).toBe(true);
  });

  it('maps null and undefined to null', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
  });

  it('keeps small bigints as numbers', () => {
    expect(normalizeValue(123n)).toBe(123);
    expect(typeof normalizeValue(123n)).toBe('number');
  });

  it('keeps large bigints as strings, to preserve exactness', () => {
    // Past 2^53 a JS number silently rounds; the true digits must survive.
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    expect(normalizeValue(big)).toBe('9007199254740993');
  });

  it('renders objects as JSON rather than [object Object]', () => {
    expect(normalizeValue({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('does not throw on a bigint nested in an object', () => {
    expect(normalizeValue({ n: 10n })).toBe('{"n":"10"}');
  });

  it('summarises binary views instead of dumping bytes', () => {
    expect(normalizeValue(new Uint8Array([1, 2, 3]))).toBe('[3 bytes]');
  });
});
