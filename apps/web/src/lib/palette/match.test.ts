import { describe, expect, it } from 'vitest';

import { filterCommands, fuzzyMatch } from './match';

describe('fuzzyMatch', () => {
  it('matches a subsequence, not just a substring', () => {
    expect(fuzzyMatch('Group and summarise', 'gsum')).not.toBeNull();
  });

  it('reports where it matched, for highlighting', () => {
    expect(fuzzyMatch('abc', 'ac')?.indices).toEqual([0, 2]);
  });

  it('returns null when a character is missing', () => {
    expect(fuzzyMatch('Group and summarise', 'gzz')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('Toggle Theme', 'TT')).not.toBeNull();
  });

  it('scores consecutive characters above scattered ones', () => {
    const consecutive = fuzzyMatch('theme toggle', 'the')!.score;
    const scattered = fuzzyMatch('the very best hover', 'the')!.score;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('anything', '')).toEqual({ score: 0, indices: [] });
  });
});

describe('filterCommands', () => {
  const commands = [
    { label: 'SQL editor' },
    { label: 'Save result as a table' },
    { label: 'Switch dataset', keywords: 'orders users' },
  ];

  it('returns everything, in order, for an empty query', () => {
    expect(filterCommands(commands, '  ').map((match) => match.item.label)).toEqual([
      'SQL editor',
      'Save result as a table',
      'Switch dataset',
    ]);
  });

  it('ranks the tighter match first', () => {
    expect(filterCommands(commands, 'sql')[0]?.item.label).toBe('SQL editor');
  });

  it('falls back to keywords when the label does not match', () => {
    const matches = filterCommands(commands, 'orders');
    expect(matches[0]?.item.label).toBe('Switch dataset');
  });

  it('ranks a label match above a keyword match', () => {
    const items = [{ label: 'zzz', keywords: 'table' }, { label: 'table' }];
    expect(filterCommands(items, 'table')[0]?.item.label).toBe('table');
  });

  it('drops non-matches entirely', () => {
    expect(filterCommands(commands, 'qqqq')).toEqual([]);
  });
});
