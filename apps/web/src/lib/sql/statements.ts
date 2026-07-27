/**
 * Splitting a SQL buffer into statements.
 *
 * A naive `split(';')` is wrong the moment a semicolon appears inside a string
 * literal or a comment — `SELECT 'a;b'` would become two broken statements. The
 * editor needs this to be right for "run the statement under the cursor" and for
 * deciding whether a buffer is a single query (which is what `COPY (…) TO` and
 * the chart compiler can wrap).
 */

export interface Statement {
  sql: string;
  /** Offset of the first character in the original buffer. */
  start: number;
  /** Offset one past the last character (excluding the terminating `;`). */
  end: number;
}

export function splitStatements(buffer: string): Statement[] {
  const statements: Statement[] = [];
  let start = 0;
  let index = 0;

  while (index < buffer.length) {
    const char = buffer[index]!;
    const next = buffer[index + 1];

    if (char === '-' && next === '-') {
      index = skipTo(buffer, index, '\n');
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipTo(buffer, index + 2, '*/');
      continue;
    }
    if (char === "'" || char === '"') {
      index = skipQuoted(buffer, index, char);
      continue;
    }
    if (char === '$') {
      // DuckDB supports `$$dollar quoted$$` bodies; the tag between the dollars
      // may be empty or a bare identifier.
      const tag = /^\$(\w*)\$/.exec(buffer.slice(index));
      if (tag) {
        index = skipTo(buffer, index + tag[0].length, tag[0]);
        continue;
      }
    }
    if (char === ';') {
      push(statements, buffer, start, index);
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }

  push(statements, buffer, start, buffer.length);
  return statements;
}

/** The statement containing `offset`, for "run the statement under the cursor". */
export function statementAt(buffer: string, offset: number): Statement | null {
  const statements = splitStatements(buffer);
  return (
    statements.find((statement) => offset >= statement.start && offset <= statement.end) ??
    statements.at(-1) ??
    null
  );
}

/** True when the buffer holds exactly one statement — wrappable in `COPY (…)`. */
export function isSingleStatement(buffer: string): boolean {
  return splitStatements(buffer).length === 1;
}

function push(into: Statement[], buffer: string, start: number, end: number): void {
  const raw = buffer.slice(start, end);
  if (raw.trim().length === 0) return;
  // Report the trimmed span so cursor lookups don't land on leading whitespace
  // that belongs to the previous statement.
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  into.push({ sql: raw.trim(), start: start + leading, end: end - trailing });
}

function skipTo(buffer: string, from: number, terminator: string): number {
  const found = buffer.indexOf(terminator, from);
  return found === -1 ? buffer.length : found + terminator.length;
}

function skipQuoted(buffer: string, from: number, quote: string): number {
  let index = from + 1;
  while (index < buffer.length) {
    if (buffer[index] === '\\') {
      index += 2;
      continue;
    }
    if (buffer[index] === quote) {
      // A doubled quote is an escaped quote, not the end of the literal.
      if (buffer[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return buffer.length;
}
