# Frontend — Phase 3: Visualization & Dashboards

## Goal

Let users turn any query result into charts, compose charts into dashboards, and export/share their work as files — still fully client-side.

## Prerequisites

- Frontend Phase 2 complete (SQL editor, transformations, exports).

## Scope

### 1. Chart builder

- [x] "Chart" tab beside the results grid on every query tab, with the encoding panel and a live preview.
- [x] Chart types: bar (grouped/stacked), line, area, scatter (with bubble size), pie/donut, histogram, big-number, table.
- [x] Encoding panel: x / y / series / size, with defaults inferred from column types — temporal → line, categorical + numeric → bar, two numerics → scatter, a lone measure → **big number** (not a one-bar bar chart), nothing numeric → table.
- [x] Aggregation control (count / distinct / sum / avg / min / max / median) compiled into the `GROUP BY`, never computed in JS.
- [x] Options: title, axis labels, number format, legend position, log scale (ignored when any value is ≤ 0, where a log axis is undefined), stacking, donut, bin count.
- [x] Large-data handling: aggregation and top-N happen in SQL; a scatter is downsampled by DuckDB with `USING SAMPLE`, capped at 10k points. A `LIMIT` would take the *first* N rows, which is not a picture of a distribution — a sample is.

### 2. Chart engine

- [x] ECharts, registered piecewise through `echarts/core` so only the six drawn forms are in the chunk, behind a dynamic import — [echarts-loader.ts](../../apps/web/src/lib/charts/echarts-loader.ts).
- [x] Internal **chart spec** (`{ version, id, type, query, encoding, options }`) — serializable, versioned, ECharts-independent. [spec.ts](../../apps/web/src/lib/charts/spec.ts) · [compile.ts](../../apps/web/src/lib/charts/compile.ts) · [echarts.ts](../../apps/web/src/lib/charts/echarts.ts).
- [x] Dataviz conventions followed and **verified with the palette validator**, not by eye — see the note below.

### 3. Dashboards

- [x] Dashboard = named collection of chart specs on a 12-column react-grid-layout: drag (by the tile header only), resize, reorder.
- [x] "Add to" from any chart tab. The spec is **copied with a fresh id**, so editing the tab's chart later can't silently rewrite a finished dashboard.
- [x] Auto-refresh: tiles re-run against the current tables. Falls out of the design rather than needing invalidation — nothing is cached, and `useChartData` treats the catalogue as a dependency, so re-importing a file updates every dashboard built on it.
- [x] Filter bar: a global date range and categorical dropdowns that inject `WHERE` clauses. Filters name a *column*, and only apply to member charts whose result has it (`filtersFor`), so one control filters six charts built on different queries.
- [x] Persisted to IndexedDB ([idb.ts](../../apps/web/src/lib/storage/idb.ts)); server persistence arrives with Backend Phase 2.

### 4. Export & share (file-based)

- [x] Chart as PNG (from the live canvas) and SVG (from a second, headless SVG-renderer instance — an ECharts instance is bound to one renderer for its lifetime).
- [x] Dashboard as PDF (jsPDF, dynamically imported) and as a **standalone HTML file**.
- [x] Export/import **workbench file** (`.dwb.json`): dataset *metadata*, queries, chart specs, snippets and dashboards. Import lists exactly which data files still need dropping in, rather than restoring silently and leaving broken tiles.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Chart library | ECharts (core + 6 forms) | Canvas handles big series; rich types; theming |
| Spec format | Own JSON spec, not vega-lite | Small surface we control; maps 1:1 to the encoding panel; easy to persist and diff |
| Data flow | Spec owns a SQL query; engine aggregates | The browser never aggregates; charts stay fast on 10M-row tables |
| Layout | react-grid-layout | Battle-tested drag/resize grid |
| Standalone HTML | Inline **SVG** + embedded data, not a bundled renderer | Inlining ECharts would add ~1 MB to every export and make the file depend on JS running at all |

## Deliverables & Acceptance Criteria

1. [x] Bar, line and scatter each build in well under a minute from a result, with correct type-driven defaults — covered by the Playwright suite.
2. [~] Aggregation is pushed to DuckDB and each tile's query is bounded, so a six-chart dashboard is six small queries regardless of table size. **Not yet timed against the 5M-row / 3s figure** — the mechanism is size-independent but that number is unverified.
3. [x] Dashboards survive reload (asserted in Playwright, including the cold-start case where tables are still restoring). The workbench file round-trips.
4. [x] PNG / SVG / PDF / HTML all export locally, with the surface colour baked in so they don't render as black squares in other viewers. Light and dark both produce correct output; HTML export is asserted end-to-end.
5. [x] Chart spec → SQL is unit-tested (24 cases), as is the reshaping and series folding (13 cases). Chart rendering is asserted in Playwright rather than by screenshot diffing — a pixel baseline for a canvas chart is brittle across platforms, so the tests assert the chart *mounts, re-renders on type change, and produces a file*.

## The palette is validated, not chosen by eye

The categorical hues and, crucially, **their order** come from the project's dataviz conventions and were checked with the validator against this app's own chart surfaces (`#ffffff` light, `#22272e` dark):

```
light — adjacent CVD ΔE 9.1, normal-vision ΔE 19.6 — all bands pass
dark  — adjacent CVD ΔE 8.4, normal-vision ΔE 19.3 — all bands pass
```

Three light-mode hues sit below 3:1 contrast on white. The documented relief is "visible labels or a table view", and the app ships both — every multi-series chart carries a legend, and the Results tab beside the chart is the same data as a table.

Two rules the palette can't enforce alone are enforced in code: hues are assigned in fixed order and **never cycled** (a ninth series folds into "Other" rather than inventing a colour), and scatter — where any series can sit beside any other — caps at **three** series, because only the first three slots clear the gates on *all* pairs rather than adjacent ones. Regeneration commands are in [theme.ts](../../apps/web/src/lib/charts/theme.ts).

Mark specs are fixed rather than per-chart: bars cap at 24px with a 4px rounded data-end, lines are 2px, markers ≥ 8px with a 2px surface ring, area fills are a 10% wash, touching fills are separated by 2px of *surface colour* rather than a stroke, gridlines are hairline and solid, and text always wears an ink token — never the series colour. There is never a second y-axis.

## Estimated Effort

~3 weeks for one developer.

## Out of Scope (later phases)

Server-stored dashboards and shared links (Backend Phase 2 + FE Phase 4), AI-suggested charts (AI Phase 2), live/streaming data sources.
