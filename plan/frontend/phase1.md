# Frontend — Phase 1: Foundation & Data Ingestion

## Goal

A working Next.js app where a user can drop a data file (CSV, Excel, Parquet, JSON), have it loaded into DuckDB-WASM inside the browser, and see a fast, paginated preview of the data — with zero backend and zero account required.

## Prerequisites

- None. This phase starts the project.

## Scope

### 1. Project scaffolding

- [x] `apps/web` on **Next.js 15** (App Router), TypeScript strict (+ `noUncheckedIndexedAccess`), ESLint flat config, Prettier.
- [x] Tailwind **v4** with a semantic CSS-variable palette; light/dark toggle, applied pre-paint via an inline script so there's no flash. *(shadcn/ui not pulled in — its primitives weren't needed for these components; the tokens are shadcn-compatible if we add it later.)*
- [x] Zustand stores: `datasets` (engine status, loaded datasets, active table) and `ui` (theme, sidebar — persisted).
- [x] Shell: TopBar (logo, dataset switcher, theme, clear), Sidebar (datasets + expandable column/type list), main area, StatusBar (engine dot, row/col counts, query time).
- [x] Error boundary (keeps a render error from losing loaded data) + sonner toasts.

### 2. DuckDB-WASM engine integration

- [x] Singleton `DataEngine` ([lib/engine/engine.ts](../../apps/web/src/lib/engine/engine.ts)) in a Web Worker, lazy + deduplicated init: `query`, `importFile`, `preview`, `describeTable`, `listTables`, `dropTable`, `dispose`.
- [x] WASM bundle **and** its loadable extensions (`json`, `parquet`) self-hosted in `public/duckdb/` by [copy-duckdb.mjs](../../apps/web/scripts/copy-duckdb.mjs). **Verified zero external network requests** on a full 5-format import — offline-capable, nothing leaves the browser. Runtime falls back to the DuckDB CDN only if the build-time mirror fails.
- [x] Status (`idle`/`initializing`/`ready`/`error`) in the status bar, coloured dot + message.
- [x] COOP/COEP/CORP headers in [next.config.ts](../../apps/web/next.config.ts); page is cross-origin isolated (verified). **See the note below — we run the `eh` bundle, not the threaded one.**

### 3. File ingestion

- [x] Drop zone + picker for `.csv .tsv .json .parquet .xlsx`. CSV/TSV/JSON/Parquet register straight into DuckDB; XLSX is parsed by SheetJS (dynamically imported) into rows fed through `read_json_auto`.
- [x] Import dialog: editable table name (SQL-safe, derived from filename), CSV delimiter/header sniff + preview, Excel sheet picker.
- [x] Multiple datasets side by side; all 5 formats loaded together and switched via the sidebar (verified).
- [x] Warns above 500 MB in the import dialog, pointing at server-side compute as the path for larger files.
- [x] Sidebar lists each dataset with row/col/byte counts, expandable columns, and a remove action.

### 4. Data preview grid

- [x] Row-virtualised grid (TanStack Virtual) over Arrow results — [DataGrid.tsx](../../apps/web/src/components/grid/DataGrid.tsx).
- [x] Type icons (number/text/date/boolean/other) in headers and sidebar.
- [x] Paged in SQL (`LIMIT 1000 OFFSET n`); the full table is never materialised in JS.
- [x] Sort delegates to `ORDER BY` (tri-state: asc → desc → off); pointer-drag column resize.
- [x] NULLs styled distinctly, horizontal scroll for wide tables, double-click to copy a cell. **Temporal columns render as readable dates** (DuckDB's Arrow proxy returns epoch-ms — verified with a probe, since an early version mis-scaled and showed "Invalid date").

### 5. Local persistence (session survival)

- [x] Files persisted to OPFS + a manifest; reload re-imports them (DuckDB-WASM is in-memory, so its catalog can't survive a reload — replaying the bytes is simpler and self-healing). Verified all 5 restore.
- [x] "Clear workspace" wipes OPFS and disposes the engine.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Query engine | DuckDB-WASM in a Web Worker | Full SQL on large files, off-main-thread, Arrow-native |
| Data interchange | Apache Arrow | Zero-copy between DuckDB and the grid |
| Grid | TanStack Table + Virtual | Headless, virtualizes millions of rows |
| State | Zustand | Minimal boilerplate; engine handle lives outside React |
| File persistence | OPFS with IndexedDB fallback | Fast, private, survives reloads |

## Directory Sketch

```
apps/web/src/
├── app/                 # routes: / (workbench)
├── components/
│   ├── layout/          # TopBar, Sidebar, StatusBar
│   ├── ingest/          # DropZone, ImportDialog
│   └── grid/            # DataGrid, ColumnHeader, TypeIcon
├── lib/
│   ├── engine/          # duckdb worker, DataEngine API, arrow helpers
│   └── files/           # OPFS store, xlsx parsing
└── stores/              # zustand: datasets, ui
```

## Deliverables & Acceptance Criteria

1. [x] `pnpm dev` starts the app; DuckDB reports **ready in ~0.9s** (budget ~2s) — verified in a headless Chromium run.
2. [~] A 50k-row CSV imports in **~160 ms** and previews without freezing; UI stays responsive throughout. **Not yet timed at the full 100 MB** — the engine work is the same, but the number in the criterion is unverified.
3. [x] All five formats import; Excel sheet selection works — verified end to end.
4. [x] Multiple datasets side by side, switched via the sidebar — verified with all five loaded at once.
5. [x] Reload restores every dataset from OPFS — verified.
6. [x] CI ([web.yml](../../.github/workflows/web.yml)) runs lint + typecheck + 39 unit tests + build on every PR.

**Verified in-browser** (headless Chromium via Playwright): cross-origin isolated, engine ready ~0.9s, all 5 formats import and restore, sort pushes to SQL, dates render correctly, and **zero external network requests** across a full session.

## Key decision made during the build: `eh` bundle, not `coi`

The plan assumed the threaded (coi) DuckDB build for `SharedArrayBuffer`. In practice its loadable extensions are compiled against non-shared memory, so `json` (needed by JSON *and* Excel import) fails to load on it — "mismatch in shared state of memory". We run the `eh` bundle instead: still entirely in a Web Worker (the main thread never blocks), every format works, at the cost of in-engine threading — which FE1 doesn't need, since the large-file story is server-side compute. The COOP/COEP headers are kept (the page is still cross-origin isolated) and harmless.

## Bugs found and fixed while verifying

- **Engine never booted on a first visit** — startup was chained behind OPFS restore, which returns early when nothing is saved. Boot is now unconditional.
- **OPFS persisted 0-byte files** — DuckDB's `registerFileBuffer` transfers (detaches) the buffer, so persisting *after* import wrote nothing; session restore silently did nothing. Now persists before the transfer, and refuses to write an empty buffer.
- **Dates rendered as raw epoch integers**, then as "Invalid date" — the Arrow proxy already returns epoch-ms; the fix was to stop re-scaling by the storage unit.

## Estimated Effort

~2–3 weeks for one developer.

## Out of Scope (later phases)

User-written SQL (Phase 2), charts (Phase 3), accounts/AI (Phase 4), files beyond browser memory (Backend Phase 3).
