/**
 * Delimiter and header detection for the import dialog's preview.
 *
 * DuckDB's `read_csv(auto_detect=true)` does its own, better sniffing at import
 * time — this exists only so the dialog can *show* the user what it's about to
 * do, and let them override it. It deliberately looks at a small prefix.
 */

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;
export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];

export interface CsvSniff {
  delimiter: Delimiter;
  hasHeader: boolean;
  /** Parsed preview rows, header included when present. */
  preview: string[][];
}

const PREVIEW_BYTES = 64 * 1024;
const PREVIEW_ROWS = 20;

export function sniffCsv(sample: string): CsvSniff {
  const lines = sample.split(/\r?\n/).filter((line) => line.length > 0).slice(0, PREVIEW_ROWS);
  if (lines.length === 0) {
    return { delimiter: ',', hasHeader: false, preview: [] };
  }

  const delimiter = pickDelimiter(lines);
  const preview = lines.map((line) => splitLine(line, delimiter));
  return { delimiter, hasHeader: looksLikeHeader(preview), preview };
}

export function decodePreview(data: Uint8Array): string {
  const slice = data.subarray(0, PREVIEW_BYTES);
  // `fatal: false` so a multi-byte character split by the slice boundary
  // degrades to a replacement character instead of throwing.
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

/**
 * The delimiter that splits lines most *consistently*.
 *
 * Frequency alone is a bad signal — prose full of commas beats a genuine
 * pipe-delimited file. A real delimiter yields the same field count on every
 * row, so consistency is the thing to rank on, with count as the tiebreak.
 */
function pickDelimiter(lines: string[]): Delimiter {
  let best: Delimiter = ',';
  let bestScore = -Infinity;

  for (const candidate of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, candidate).length);
    const first = counts[0] ?? 1;
    if (first < 2) continue; // Didn't split anything.

    const consistent = counts.every((count) => count === first);
    const score = (consistent ? 1000 : 0) + first;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Split one line, honouring double quotes. */
export function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Treat row 1 as a header when it's all non-numeric and row 2 isn't.
 *
 * A header of words above a body of numbers is the overwhelmingly common case;
 * anything more clever here would just disagree with DuckDB's own detection.
 */
function looksLikeHeader(rows: string[][]): boolean {
  const [first, second] = rows;
  if (!first) return false;
  if (first.some((cell) => cell.trim() === '')) return false;

  const allText = first.every((cell) => !isNumeric(cell));
  if (!second) return allText;

  const secondHasNumber = second.some((cell) => isNumeric(cell));
  return allText && secondHasNumber;
}

function isNumeric(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed));
}
