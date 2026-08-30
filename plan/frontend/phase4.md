# Frontend — Phase 4: AI Integration, Accounts & Polish

## Goal

Connect the local-first workbench to the platform: sign-in, cloud-saved workspaces, shared links, and the AI assistant UI (ask-in-English → SQL, insights, chat). Finish with performance/accessibility polish for launch.

## Status

**Sections 1, 2 and 4 are complete. Section 3 is complete except the insights panel.**

The backend dependencies landed, so the client was generated from the real OpenAPI document rather than an imagined one — the convention in [overview.md](../overview.md) held, and the payload cloud sync carries turned out to be exactly the `.dwb.json` shape as predicted.

| Section | State |
|---|---|
| 1. API client & auth | Done — generated client, in-memory access token, refresh-on-401, sign up/in/out |
| 2. Cloud workspaces | Done — switcher, snapshot save/open, ETag conflict prompt, share links, `/w/{token}` |
| 3. AI assistant UI | Ask / Fix / Explain and the analyst chat done. **Insights panel not built** |
| 4. Launch polish | Done (unchanged) |

**How the analyst works.** The backend owns the model loop and pauses on `awaiting_tools`; `lib/ai/tools.ts` runs the six tools against DuckDB-WASM and POSTs the results back, and `stores/analyst.ts` drives that as a loop rather than a single request. Three invariants make it work: every pending call returns a result (the server rejects a mismatched `tool_use_id` set), failures come back as `is_error` results so the model self-corrects rather than the turn dying, and results are budgeted client-side because the server truncates at a fixed character count with no idea what it is cutting. Iteration limits are the server's (40 turns, 15 tool calls per turn, a session token budget, a forced tools-off wrap-up), not duplicated here.

Bundle impact of everything above: initial JS went from 247 KB to **254.6 KB gzipped, against the 300 KB budget**. The AI dialog and the analyst panel are both behind dynamic imports, so a build with no API configured never fetches either chunk.

## Prerequisites

- Frontend Phase 3 complete. ✅
- Backend Phase 1–2 live (auth, workspace persistence APIs). ✅
- AI Phase 1 live (NL→SQL endpoint). ✅

## Scope

### 1. API client & auth

- [x] Typed API client generated from the FastAPI OpenAPI schema (`openapi-typescript` + a fetch wrapper) into `apps/web/src/lib/api/` — not `packages/shared`, since there is still exactly one consumer and a package for one importer is ceremony.
- [x] Auth flows: sign up / sign in (email+password), session refresh, sign out. **OAuth buttons not built** — the API supports Google and GitHub, the UI doesn't offer them yet.
- [x] **The app is still fully usable anonymously** — no account, no gate, and with `NEXT_PUBLIC_API_URL` unset, no network call at all. Every cloud surface is behind one `apiConfigured()` gate, so signing in adds features without ever moving where queries run.

### 2. Cloud workspaces

- [x] Workspace switcher in the top bar.
- [x] Save-to-cloud: queries, chart specs, dashboards, dataset *metadata*. **Raw-file upload not built** — the API supports it; the browser-to-S3 flow isn't wired.
- [x] Sync model: last-write-wins guarded by the snapshot `ETag` replayed as `If-Match`; a 409 opens a prompt rather than silently discarding either side.
- [x] Shared links: `/w/{token}` read-only route, "copy into my workbench" (local, additive) and "fork to my account" (server-side).
- [x] Groundwork: the workbench file already serialises exactly this payload and deliberately contains **no rows**, so the local artifact and the sync payload are the same shape.

### 3. AI assistant UI

- [x] Ask AI: English → streamed SQL → preview → the user puts it in the editor and runs it themselves. Nothing auto-executes.
- [x] What was sent is stated in the dialog: table and column names and types, no rows or cell values.
- [x] Fix-my-query on a SQL error, passing DuckDB's own message rather than the UI's paraphrase.
- [x] Analyst chat (AI Phase 3): browser tool executor + conversational panel, gated on an explicit one-time consent because it is the only feature that sends cell values off the machine.
- [ ] Insights panel (AI Phase 2) — the one remaining gap.
- [x] SSE over `fetch` (EventSource can't POST or carry a bearer token), with a stop button that aborts the connection so the server stops generating.
- [x] Groundwork: `catalog()` already produces the schema payload an NL→SQL call needs, and `parseSqlError` already produces the structured error a fix-my-query call would send.

### 4. Launch polish — complete

- [x] **Performance.** Monaco, ECharts, jsPDF, DuckDB and the dashboard grid are all behind dynamic imports; the SQL and Dashboards views are route-level split ([lazy.tsx](../../apps/web/src/components/workbench/lazy.tsx)). Initial JS is **254.6 KB gzipped against a 300 KB budget** (247 KB before the API client landed), enforced in CI by [check-bundle-size.mjs](../../apps/web/scripts/check-bundle-size.mjs) — which names the usual offenders in its failure message.
- [x] **Accessibility.** Keyboard navigation through the grid (arrows, shift-extend, `Cmd+A`, `Cmd+C`), the editor, the palette and the menus; a real focus trap with focus restoration in every dialog ([Dialog.tsx](../../apps/web/src/components/ui/Dialog.tsx)); visible focus rings; `prefers-reduced-motion` honoured in CSS *and* in ECharts, which draws to a canvas the CSS can't reach.
- [x] **Onboarding.** A three-panel first-run tour that leads with the privacy model, and two bundled sample datasets — deliberately *two*, so the first five minutes can cover a join. Generated by [make-samples.mjs](../../apps/web/scripts/make-samples.mjs) with nulls, a duplicate key and some unmatched foreign keys left in on purpose.
- [x] **Empty, loading and error states** for every panel: drop zone, SQL view without data, dashboards without charts, a dashboard without tiles, history, snippets, schema tree, idle results, chart errors, and lazy-chunk skeletons.
- [x] **Telemetry — opt-in, counts only, and never transmitted.** A closed union of event names with no payload parameter, so no caller *can* pass a table name or a value through it. The settings dialog shows the entire recorded record; opting out deletes it. Nine unit tests pin those properties, including one asserting `fetch` is never called.
- [x] **E2E suite (Playwright, 15 tests)** across import → query → chart → dashboard → export, plus onboarding, persistence and privacy. Runs against a **production build**, because the lazy chunks and the COOP/COEP headers are exactly what dev mode wouldn't exercise. One test asserts the product's central claim directly: **zero requests to any external host** across a full session.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| API types | Generated from OpenAPI | One contract, no drift — which is also why the client isn't hand-written ahead of the API |
| AI SQL safety | AI output is always a *proposal*; the user runs it | Explicit-run builds trust and teaches |
| Sync strategy | Metadata-first, last-write-wins | Ships collaboration value without CRDT complexity |
| Streaming | SSE over fetch | Simple, proxy-friendly, matches FastAPI `StreamingResponse` |

## Deliverables & Acceptance Criteria

1. [x] The anonymous experience is complete and unbroken, and signing in adds cloud features without altering the local flow.
2. [x] A workspace saved on laptop A opens on laptop B.
3. [x] A shared link opens read-only.
4. [x] "Ask AI" and fix-my-query (need `GEMINI_API_KEY` server-side; without it the endpoints answer 503 by design).
5. [x] **Lighthouse (desktop, workbench route): performance 100, accessibility 100, best-practices 100, SEO 100.** Budget was ≥ 90 / ≥ 95. FCP 0.2 s, LCP 0.6 s, TBT 0 ms, CLS 0.
6. [x] Playwright suite green, wired into CI as its own job with failure artifacts.

## Bugs found and fixed during the polish pass

- **`/favicon.ico` 404'd on every page load** and cost a Lighthouse best-practices point. The icon was in `public/`, which the App Router shadows for reserved metadata paths; it belongs at `app/icon.svg`.
- **The command palette button's visible "⌘K" wasn't part of its accessible name**, so a speech-control user saying what they could see wouldn't have matched it.
- **Dashboard tiles raced OPFS restore.** Opening a dashboard on a cold page queried before the tables existed and then never retried, leaving every tile permanently reading "table does not exist". Fixed by making the catalogue a dependency of chart data — which is also what makes the plan's dashboard auto-refresh work.

## Estimated Effort

~3 weeks for one developer (chat panel portions track AI Phase 3 timing).

## Out of Scope

Real-time multi-cursor collaboration, mobile-optimized layout, native desktop wrapper — post-launch candidates.
