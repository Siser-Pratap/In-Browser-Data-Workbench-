# Frontend — Phase 2: Core Workbench (SQL Editor & Transformations)

## Goal

Turn the file viewer into a real workbench: a first-class SQL editor with autocomplete, a schema explorer, query history, and no-code transformation tools — everything still 100% in-browser.

## Prerequisites

- Frontend Phase 1 complete (engine, ingestion, grid).

## Scope

### 1. SQL editor

- [x] Monaco integrated with the `sql` language mode — [SqlEditor.tsx](../../apps/web/src/components/editor/SqlEditor.tsx). **Self-hosted, not CDN-loaded** (see the note below).
- [x] Schema-aware autocomplete fed from `information_schema` via [catalog.ts](../../apps/web/src/stores/catalog.ts): tables, columns, DuckDB keywords, ~50 functions, saved snippets. Alias-aware — `SELECT o.` completes `orders`' columns, even when the `FROM` clause is to the *right* of the cursor. Logic is pure and unit-tested in [completion.ts](../../apps/web/src/lib/sql/completion.ts).
- [x] `Cmd/Ctrl+Enter` runs the buffer; running a **selection** runs only that.
- [x] Multiple query tabs, each with its own result and its own Monaco instance (so undo history can't leak between tabs). Tabs restore from localStorage; **results deliberately do not persist** — they're the user's data, and re-running is cheap.
- [x] Cancel (DuckDB `cancelPendingQuery` via a streamed `send()`), elapsed time, row-count summary. A cancelled query keeps its partial rows and the grid labels them as partial.
- [x] DuckDB errors mapped to a title/detail/hint with the position parsed out of the caret diagram and squiggled in the editor — [errors.ts](../../apps/web/src/lib/sql/errors.ts).
- [x] SQL formatting (`sql-formatter`, DuckDB dialect) via the Format button / `Shift+Alt+F`.

### 2. Schema explorer

- [x] Sidebar tree over the **catalogue**, not the import list — so tables made by `CREATE TABLE AS` or a transformation appear alongside dropped files.
- [x] Per-column stats popover, computed lazily: rows, null count and share, approximate distinct count, min/max, top 5 values with bars.
- [x] Actions: click-to-insert into the editor (falls back to copying when no editor is open), query-this-table, edit columns, rename table, drop table.

### 3. Results grid upgrades

- [x] Grid split into a presentational [ResultsGrid](../../apps/web/src/components/grid/ResultsGrid.tsx) (used by both the table preview and every query tab) with per-tab result state.
- [x] Cell/row/column selection — click, shift-click, drag, `Cmd+A`, arrow-key navigation — with copy-as-CSV (`Cmd+C`) and copy-as-Markdown (`Cmd+Shift+C`). Serialisers are unit-tested.
- [x] Export CSV / JSON / Parquet through `COPY … TO` inside DuckDB, downloaded from its virtual FS — so an export covers the *whole result*, not the ≤50k rows the grid holds.
- [x] Save a result as a new table (`CREATE OR REPLACE TABLE … AS`), with the SQL shown first.

### 4. No-code transformations (SQL-backed)

- [x] Column operations: rename, cast (via `TRY_CAST`, so one bad row can't abort the change), drop, reorder.
- [x] Filter builder: column / operator / value rows combined with AND/OR, with type-aware literals — numbers stay unquoted so `9 > 10` can't happen.
- [x] Derived columns with a function palette and a column palette.
- [x] Aggregate builder: group-by columns + measures + sort + limit.
- [x] Join builder: two tables, key pairs, join type. **Refuses to emit a keyless inner join** rather than generating an accidental cartesian product.
- [x] The generated SQL is on screen the whole time, not behind a toggle, and the only exit is "Open in editor" — nothing runs until the user reads it and presses Run.

### 5. Query history & snippets

- [x] Every execution logged to IndexedDB with timestamp, duration, row count, success, and the tables in scope. Capped at 500, oldest evicted from memory *and* storage.
- [x] History panel: search over SQL and table names, re-run in a new tab, pin as a snippet, delete, clear.
- [x] Snippets appear in Monaco's autocomplete and in the command palette.

### 6. Command palette

- [x] `Cmd/Ctrl+K` with fuzzy subsequence matching ([match.ts](../../apps/web/src/lib/palette/match.ts), unit-tested): switch view, preview or query any table, jump to a tab, run a snippet, toggle panels, run/format the current query.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Editor | Monaco, **bundled from node_modules** | Best-in-class SQL editing, marker API for error squiggles |
| Monaco entry | Custom SQL-only build ([monaco-sql.ts](../../apps/web/src/lib/editor/monaco-sql.ts)) | The default entry bundles every language *and* the TypeScript compiler — megabytes nobody writing SQL executes |
| Autocomplete source | Live `information_schema`, read at request time | Always correct; a table created a second ago is already suggestible |
| Transformation model | UI → spec → SQL string (one direction) | Keeps SQL the single source of truth and the output inspectable |
| Query cancellation | `connection.send()` + `cancelSent()` | `query()` can't be cancelled; streaming also gives the row cap a natural home |

## Deliverables & Acceptance Criteria

1. [x] Joins, CTEs and window functions are all writable with autocomplete help; aliases resolve.
2. [x] A non-SQL user can filter, derive a column and build a group-by through the UI and see the SQL each step generated.
3. [x] A long query can be stopped; the partial result is shown and labelled. The UI stays responsive because DuckDB is in a Worker.
4. [x] History survives reload (IndexedDB); a pinned snippet re-runs from the palette.
5. [~] Exports go through `COPY … TO`, so they are bounded by memory rather than by the grid — **not yet timed on a 1M-row result**; the mechanism is size-independent but the number in the criterion is unverified.
6. [x] SQL generation covered by golden-string unit tests (transformations, statement splitting, error parsing, completion ranking). **Editor and builders are covered by the Playwright suite rather than by component tests** — the interesting failures there are Monaco actually mounting and the engine actually answering, which jsdom can't observe.

## Notes from the build

**Monaco is bundled, not fetched.** The usual `@monaco-editor/react` setup pulls Monaco from jsdelivr at runtime, which would break the product's central claim and would be blocked anyway by the `Cross-Origin-Embedder-Policy: require-corp` header DuckDB needs. It's imported from node_modules behind a dynamic `import()`, and the entry is a hand-assembled SQL-only build — Monaco's own `editor.main.js` minus the ~90 language definitions and the CSS/HTML/JSON/TypeScript language services. Regeneration instructions are in the file.

**Results are never persisted.** Tabs, snippets and history are; result rows are not. Writing tens of thousands of the user's rows into localStorage on every query is exactly what this product promises not to do, and they'd go stale on the next import anyway.

## Bugs found and fixed while verifying

- **`reader.schema` was undefined on every user query.** `connection.send()` returns an Arrow reader that hasn't read its schema message yet, so the first real query failed with "Cannot read properties of undefined (reading 'fields')". Now opened explicitly, with the first batch's schema as a fallback.
- **Query-result columns were mistyped.** `kindForDuckDbType` only understood DuckDB's spellings (`VARCHAR`, `BIGINT`), but a *result* is read out of Arrow, which says `Utf8` and `Int64`. Every text column in a query result was classified `other`, which silently stopped the chart builder from ever treating one as a category. It now understands both vocabularies — plus `Dictionary<…>` enums, and `INTERVAL`, which the old ordering read as a number because of the `INT` in its name.
- **The preview grid could hang on its spinner.** Paging quickly left two previews in flight; a slow earlier one landing last stored a page under a key nobody was waiting for, and nothing re-requested it.

## Estimated Effort

~3 weeks for one developer.

## Out of Scope (later phases)

Charts (Phase 3), AI-generated SQL (Phase 4 UI, AI Phase 1 engine), cross-user sharing (Backend Phase 2).
