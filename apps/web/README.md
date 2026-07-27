# Data Workbench — web

A privacy-first data workbench that runs **in the browser**. Drop in a CSV,
Excel, Parquet or JSON file and query it with SQL — every byte is parsed and
executed locally by DuckDB-WASM. Nothing is uploaded.

## Stack

- **Next.js 15** (App Router), TypeScript strict, Tailwind CSS v4
- **DuckDB-WASM** in a Web Worker — the query engine
- **Apache Arrow** — zero-copy transport from DuckDB to the grid
- **TanStack Table + Virtual** — the row-virtualised preview grid
- **Zustand** — app state (the engine handle lives outside React)

## Develop

```sh
pnpm install
pnpm dev          # predev copies the DuckDB bundle + mirrors its extensions
```

Open <http://localhost:3000>.

## Checks

```sh
pnpm lint         # eslint (flat config, type-aware on src/)
pnpm typecheck    # tsc --noEmit, strict
pnpm test         # vitest — pure logic (parsers, converters, SQL quoting)
pnpm build
```

## How it hangs together

```
src/
├── app/                 # the single workbench route + shell
├── components/
│   ├── layout/          # TopBar, Sidebar, StatusBar, ErrorBoundary, theme
│   ├── ingest/          # DropZone, ImportDialog
│   └── grid/            # DataGrid (virtualised), TypeIcon
├── lib/
│   ├── engine/          # DuckDB wrapper, Arrow→rows, SQL identifier quoting
│   └── files/           # OPFS persistence, CSV sniffing, XLSX parsing
└── stores/              # zustand: datasets, ui
```

### Things worth knowing

- **The engine is a singleton outside React.** DuckDB runs in a Worker with a
  live connection; React state holds only serialisable descriptions of what's
  loaded. See `lib/engine/engine.ts`.

- **Self-hosted, no CDN.** The DuckDB bundle *and* its loadable extensions
  (`json`, `parquet`) are copied into `public/duckdb/` by
  `scripts/copy-duckdb.mjs` and loaded from our own origin. An import makes zero
  external network calls — verified — so the app works offline and no request
  ever leaves the browser. If the build-time extension mirror fails, the runtime
  falls back to the DuckDB CDN rather than breaking.

- **The `eh` bundle, not `coi`.** DuckDB's threaded build uses SharedArrayBuffer,
  but its loadable extensions are compiled against non-shared memory, so JSON and
  Excel import fail on it outright ("mismatch in shared state of memory"). The
  `eh` bundle still runs entirely in a Worker — the main thread never blocks —
  and every format works. In-engine threading is given up; the large-file story
  is server-side compute, not browser threads.

- **Everything is pushed down to SQL.** Preview paging (`LIMIT`/`OFFSET`) and
  sorting (`ORDER BY`) run in DuckDB; a million-row table is never materialised
  in JS. Only the visible slice is rendered.

- **OPFS persistence.** Imported file bytes are stored in the Origin Private File
  System so a reload restores the workspace. It's written *before* the import,
  because DuckDB's `registerFileBuffer` transfers (detaches) the buffer — reading
  it afterwards yields zero bytes. "Clear workspace" wipes OPFS and the engine.

- **SQL identifier safety.** Table and column names come from filenames and from
  DuckDB's catalog and are interpolated into SQL (the JS API has no bound params
  for identifiers), so they're quoted via `quoteIdent`/`quoteLiteral` — the unit
  tests cover the injection cases.
