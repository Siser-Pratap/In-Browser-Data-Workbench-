import { describe, expect, it } from 'vitest';

import {
  formatFromFilename,
  kindForDuckDbType,
  quoteIdent,
  quoteLiteral,
  tableNameFromFilename,
} from './types';

describe('formatFromFilename', () => {
  it('maps known extensions, case-insensitively', () => {
    expect(formatFromFilename('sales.CSV')).toBe('csv');
    expect(formatFromFilename('data.parquet')).toBe('parquet');
    expect(formatFromFilename('book.xlsx')).toBe('xlsx');
    expect(formatFromFilename('logs.ndjson')).toBe('json');
    expect(formatFromFilename('nums.tsv')).toBe('tsv');
  });

  it('returns null for unknown or extension-less names', () => {
    expect(formatFromFilename('report.pdf')).toBeNull();
    expect(formatFromFilename('README')).toBeNull();
  });
});

describe('tableNameFromFilename', () => {
  it('derives a SQL-safe identifier', () => {
    expect(tableNameFromFilename('Sales Report 2024.csv')).toBe('sales_report_2024');
    expect(tableNameFromFilename('weird!!name@@.json')).toBe('weird_name');
  });

  it('never starts with a digit', () => {
    // A bare number is not a legal unquoted identifier.
    expect(tableNameFromFilename('2024.csv')).toBe('t_2024');
  });

  it('falls back for names that clean to nothing', () => {
    expect(tableNameFromFilename('___.csv')).toBe('dataset');
    expect(tableNameFromFilename('.csv')).toBe('dataset');
  });
});

describe('kindForDuckDbType', () => {
  it.each([
    ['BIGINT', 'number'],
    ['DECIMAL(10,2)', 'number'],
    ['DOUBLE', 'number'],
    ['VARCHAR', 'string'],
    ['TIMESTAMP', 'date'],
    ['DATE', 'date'],
    ['BOOLEAN', 'boolean'],
    ['BLOB', 'other'],
  ])('maps %s to %s', (type, kind) => {
    expect(kindForDuckDbType(type)).toBe(kind);
  });
});

describe('SQL quoting', () => {
  it('escapes embedded double quotes in identifiers', () => {
    // The injection this exists to stop: a file named `x"; DROP TABLE t; --`.
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent('normal')).toBe('"normal"');
  });

  it('escapes embedded single quotes in literals', () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });
});
