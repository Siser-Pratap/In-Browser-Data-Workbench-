/**
 * Turning a DuckDB error into something a person can act on.
 *
 * DuckDB's messages are precise but written for engine developers — they name
 * internal error classes, end in exclamation marks, and bury the position in an
 * ASCII caret diagram. This module pulls out the three things the UI wants: a
 * short title, the position to underline in the editor, and a hint about what to
 * do next. The engine's own text is always kept as `detail`, because a
 * paraphrase that loses information is worse than no paraphrase at all.
 */

export interface ParsedSqlError {
  /** Short, human-facing summary. */
  title: string;
  /** DuckDB's own message, cleaned up but not reworded. */
  detail: string;
  /** 1-based position in the statement, when DuckDB reported one. */
  position: { line: number; column: number } | null;
  /** What to try next, when the error class implies something specific. */
  hint: string | null;
}

/** Error classes DuckDB prefixes its messages with, mapped to plain language. */
const TITLES: Record<string, string> = {
  parser: 'Syntax error',
  binder: "Something in the query doesn't resolve",
  catalog: 'Unknown table or function',
  conversion: "A value couldn't be converted",
  'out of memory': 'Out of memory',
  io: "A file couldn't be read",
  invalid_input: 'Invalid input',
  not_implemented: 'Not supported by DuckDB-WASM',
  constraint: 'Constraint violated',
  dependency: 'Something else depends on this',
  permission: 'Not permitted',
  transaction: 'Transaction error',
  internal: 'Engine error',
};

export function parseSqlError(error: unknown): ParsedSqlError {
  const raw = messageOf(error).trim();
  const classMatch = /^([A-Za-z_ ]+?)\s*Error:\s*/i.exec(raw);
  const errorClass = classMatch?.[1]?.toLowerCase().trim() ?? '';
  const body = classMatch ? raw.slice(classMatch[0].length) : raw;

  return {
    title: TITLES[errorClass] ?? 'Query failed',
    detail: cleanDetail(body),
    position: parsePosition(raw),
    hint: hintFor(errorClass, body),
  };
}

/**
 * The `LINE n:` / caret block DuckDB appends to positional errors.
 *
 * The caret's column can't be read off the message directly: DuckDB prints the
 * offending source line prefixed with `LINE 3: `, then a second line whose caret
 * is aligned to the *printed* line. So the prefix width has to be subtracted
 * back out to recover a column within the user's actual SQL.
 */
function parsePosition(raw: string): { line: number; column: number } | null {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^LINE (\d+):\s?/.exec(lines[i] ?? '');
    if (!match) continue;

    const line = Number(match[1]);
    const caretLine = lines[i + 1] ?? '';
    const caretIndex = caretLine.indexOf('^');
    if (caretIndex === -1) return { line, column: 1 };
    return { line, column: Math.max(1, caretIndex - match[0].length + 1) };
  }
  return null;
}

function cleanDetail(body: string): string {
  return body
    .split('\n')
    // The caret diagram is redundant once the position is highlighted inline.
    .filter((line) => !/^LINE \d+:/.test(line) && !/^\s*\^\s*$/.test(line))
    .join('\n')
    .trim()
    .replace(/!$/, '');
}

function hintFor(errorClass: string, body: string): string | null {
  if (/Table with name (\S+) does not exist/i.test(body)) {
    return 'Check the dataset list in the sidebar — table names come from the imported filenames.';
  }
  if (/Referenced column .* not found/i.test(body)) {
    const candidates = /Candidate bindings?:\s*(.+)/i.exec(body)?.[1];
    return candidates ? `Did you mean ${candidates}?` : 'Expand the table in the sidebar to see its columns.';
  }
  if (/Scalar Function with name (\S+) does not exist/i.test(body)) {
    return 'DuckDB uses its own function names; the autocomplete list shows what is available.';
  }
  switch (errorClass) {
    case 'parser':
      return 'Press Format (Shift+Alt+F) to see where the statement stops parsing.';
    case 'out of memory':
      return 'The browser tab has a fixed memory budget. Add a LIMIT, aggregate first, or filter the rows down.';
    case 'conversion':
      return 'Use TRY_CAST instead of CAST to turn unconvertible values into NULL rather than an error.';
    default:
      return null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
