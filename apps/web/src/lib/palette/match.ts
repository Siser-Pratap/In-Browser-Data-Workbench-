/**
 * Fuzzy matching for the command palette.
 *
 * Subsequence matching, not substring: people type "gsum" for "Group and
 * summarise" and "dsh" for "Dashboards". Scoring rewards matches at word
 * boundaries and matches that stay close together, so "sql" ranks "SQL editor"
 * above "Save result as a table" even though both contain the letters in order.
 */

export interface Matchable {
  /** The text matched against. */
  label: string;
  /** Extra searchable text (a group name, a table name) — matched, not shown. */
  keywords?: string;
}

export interface Match<T> {
  item: T;
  score: number;
  /** Indices in `label` that matched, for highlighting. */
  indices: number[];
}

export function fuzzyMatch(haystack: string, needle: string): { score: number; indices: number[] } | null {
  if (needle === '') return { score: 0, indices: [] };

  const target = haystack.toLowerCase();
  const query = needle.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (const char of query) {
    const found = target.indexOf(char, cursor);
    if (found === -1) return null;

    // Consecutive characters are a much stronger signal than scattered ones.
    if (found === previous + 1) score += 8;
    // A match at the start of a word is what the typist usually intends.
    if (found === 0 || /[\s._-]/.test(target[found - 1] ?? '')) score += 6;
    // Everything else decays with distance from the start.
    score += Math.max(0, 4 - found / 8);

    indices.push(found);
    previous = found;
    cursor = found + 1;
  }

  // A short label that matched is a tighter fit than a long one that happens to
  // contain the same letters.
  return { score: score - haystack.length / 20, indices };
}

export function filterCommands<T extends Matchable>(items: T[], query: string): Match<T>[] {
  const trimmed = query.trim();
  if (!trimmed) return items.map((item) => ({ item, score: 0, indices: [] }));

  const matches: Match<T>[] = [];
  for (const item of items) {
    const onLabel = fuzzyMatch(item.label, trimmed);
    if (onLabel) {
      matches.push({ item, score: onLabel.score, indices: onLabel.indices });
      continue;
    }
    // Keywords are a fallback, scored lower so a label match always wins.
    const onKeywords = item.keywords ? fuzzyMatch(item.keywords, trimmed) : null;
    if (onKeywords) matches.push({ item, score: onKeywords.score - 20, indices: [] });
  }

  return matches.sort((a, b) => b.score - a.score);
}
