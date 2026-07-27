# Data Workbench — web

A privacy-first data workbench that runs **in the browser**. Drop in a CSV,
Excel, Parquet or JSON file and query it with SQL — every byte is parsed and
executed locally by DuckDB-WASM. Nothing is uploaded.

## What it does

Drop in a file, then either write SQL against it or point and click. Results
become charts, charts become dashboards, and dashboards export as PDF or a
self-contained HTML file. Nothing leaves the tab at any point — there is no
account, no upload, and no network request after the page loads.

## Stack

- **Next.js 15** (App Router), TypeScript strict, Tailwind CSS v4
- **DuckDB-WASM** in a Web Worker — the query engine
- **Apache Arrow** — zero-copy transport from DuckDB to the grid
- **TanStack Table + Virtual** — the row-virtualised grid
- **Monaco** — the SQL editor, bundled (never CDN-loaded)
- **ECharts** — charts, registered piecewise
- **Zustand** — app state (the engine handle lives outside React)

## Develop

```sh
pnpm install
pnpm dev          # predev copies the DuckDB bundle + mirrors its extensions
```

Open <http://localhost:3000>. There's bundled sample data behind
"Try it with sample data" if you don't have a file to hand.

## Checks

```sh
pnpm lint         # eslint (flat config, type-aware on src/)
pnpm typecheck    # tsc --noEmit, strict
pnpm test         # vitest — pure logic: SQL generation, parsing, palette, telemetry
pnpm build
pnpm size         # initial-JS budget (300 KB gzipped), enforced in CI
pnpm test:e2e     # playwright — builds and serves the app itself
pnpm samples      # regenerate public/samples (committed output)
```

## How it hangs together

```
src/
├── app/                 # the single workbench route + shell
├── components/
│   ├── layout/          # TopBar, Sidebar, StatusBar, ErrorBoundary, privacy
│   ├── ingest/          # DropZone, ImportDialog
│   ├── grid/            # ResultsGrid (virtualised, selectable), DataGrid
│   ├── editor/          # Monaco wrapper, query tabs, toolbar
│   ├── results/         # results panel: table/chart tabs, exports
│   ├── schema/          # catalogue tree, column stats popover
│   ├── transform/       # the no-code builders
│   ├── charts/          # Chart, ChartBuilder, useChartData
│   ├── dashboards/      # grid layout, filter bar, add-to-dashboard
│   ├── palette/         # Cmd/Ctrl+K
│   ├── onboarding/      # first-run tour, sample data
│   ├── workbench/       # view composition + the lazy-import boundary
│   └── ui/              # Dialog, Menu, Button, Field, SplitPane
├── lib/
│   ├── engine/          # DuckDB wrapper, Arrow→rows, SQL identifier quoting
│   ├── sql/             # formatter, error parsing, completion, transformations
│   ├── charts/          # chart spec, spec→SQL, ECharts option, palette
│   ├── export/          # serialisers, downloads, chart/dashboard/workbench files
│   ├── editor/          # Monaco loading, the SQL-only build, editor bridge
│   ├── files/           # OPFS persistence, CSV sniffing, XLSX, samples
│   ├── storage/         # IndexedDB key-value layer
│   ├── palette/         # fuzzy matching
│   └── telemetry/       # opt-in, counts-only usage counters
└── stores/              # zustand: datasets, catalog, tabs, history, dashboards, ui
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

- **Nothing heavy is in the initial bundle.** Monaco, ECharts, jsPDF, DuckDB and
  the dashboard grid are each several times the 300 KB budget on their own, and
  each sits behind a dynamic import. `pnpm size` fails CI if one escapes, and
  says which import to look for. Monaco in particular is a hand-assembled
  SQL-only entry (`lib/editor/monaco-sql.ts`) — its default entry ships every
  language *and* a copy of the TypeScript compiler.

- **Charts are queries, not data.** A chart spec owns a SQL string; the
  aggregation, the top-N and the scatter downsample all happen in DuckDB
  (`lib/charts/compile.ts`). What crosses into JavaScript is already the few
  rows the chart draws, so a dashboard over a 10M-row table costs the same as
  one over a thousand. It's also why dashboards need no cache invalidation:
  change a filter and the SQL changes, so the tiles just ask again.

- **The chart palette was validated, not chosen.** The categorical hues *and
  their order* were run through the dataviz palette validator against this app's
  own chart surfaces in both themes; the numbers and the regeneration commands
  are in `lib/charts/theme.ts`. Hues are assigned in fixed order and never
  cycled — a ninth series folds into "Other" rather than inventing a colour.

- **Telemetry is opt-in, counts-only, and never sent anywhere.** The event type
  is a closed union with no payload parameter, so no caller *can* leak a table
  name or a value through it. The privacy dialog shows the whole record; opting
  out deletes it. `lib/telemetry/telemetry.test.ts` pins those properties.
