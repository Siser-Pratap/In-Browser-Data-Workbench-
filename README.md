# In-Browser Data Workbench — Project Specification

**Status:** Direction locked, pre-implementation
**Type:** Senior-level frontend portfolio project
**Infrastructure cost:** $0 (static hosting, no backend, no GPU)

---

## 1. How we got here

The starting idea was an AI-powered UI generation engine — a visual canvas where users describe a system in plain English (or upload a screenshot/Figma file) and an AI generates UI components onto a drag-and-drop canvas, with a self-hosted model backend.

That exploration produced several useful decisions before it was set aside:

- The model should emit a **structured schema tree**, not raw code, so the canvas can manipulate it.
- Screenshots should yield a **style profile** (palette, spacing, radii, type scale, density), not a full reconstruction.
- Generation should stream **section by section**, not page-at-once.
- "Multiple designs" meant **scope inference** (one component vs. a set of pages), not alternatives to choose between.
- Generated pages should be **independent** — no cascading edits.
- RAG's real job was **constraining output to an existing component library**, not teaching design.

**Why it was set aside:** the blocker was compute. Self-hosted inference means a GPU bill, and latency math (30k+ tokens for a multi-page generation at ~40-70 tok/s) puts the product in dead territory without significant serving work. More importantly for the goal at hand — a GPU bill proves nothing about frontend skill.

That constraint is clarifying. It pushes toward projects where the difficulty lives **in the browser**, which is exactly where senior frontend ability should be demonstrated.

### Options considered

| Project | Verdict |
|---|---|
| In-browser data workbench | **Chosen** |
| Local-first collaborative canvas | Runner-up — pick only if CRDT/WebSocket experience is the specific goal |
| Browser video editor | Hardest; competes against CapCut/Resolve, so partial = broken |
| Real-time monitoring console | Great engineering, no standalone customer; demos on synthetic data |
| Builder canvas (original, minus AI) | Crowded; the AI was the differentiator |

---

## 2. What the product is

A fully client-side data workbench. Drag in a large CSV or Parquet file, query it with SQL, get results in under a second. Nothing ever leaves the machine.

**The user:** anyone handed a file too big for Excel and too small to justify a warehouse. Analysts, ops teams, data engineers doing a sanity check, journalists with a FOIA dump, anyone debugging an export.

**The pain:**
- Excel dies around a million rows.
- Uploading company data to a hosted SaaS tool is a compliance conversation.
- Writing a pandas script isn't an option for non-engineers.

**The differentiator:** client-side execution isn't a technical flourish — it's the value proposition. The file never leaves the machine, so there is no data-governance discussion. It also works offline by construction, rather than as a bolted-on feature.

This is the rare project where the impressive engineering and the believable customer story are the *same claim*, rather than two things you have to defend separately.

---

## 3. Why this is a frontend project

The obvious objection: *"isn't DuckDB doing all the work?"*

DuckDB does query execution. That's the whole of its contribution. Everything else is frontend — and the reason there's so much of it is precisely that **there's no server to offload to**.

A normal web app sends the hard parts somewhere else. Here you can't. So every problem that would have been a backend problem becomes a browser problem, and browser problems are constrained in ways server problems aren't:

- One main thread that must stay responsive
- A memory ceiling you cannot raise by provisioning more
- A tab that gets *killed*, not restarted

### The actual engineering surface

**Rendering under load**
A grid over 10M rows: virtualization with variable row heights, column resize and reorder, sticky headers, text selection across a windowed viewport — all at 60fps while query results stream in. Most virtualization implementations break the moment a second variable is introduced.

**Concurrency architecture**
DuckDB runs in a worker; so does file parsing. You design the cross-thread message protocol, handle cancellation for aborted queries, use transferable objects to avoid copying hundreds of megabytes across the boundary, and decide what state lives where. Getting this wrong is the difference between a smooth app and a frozen tab.

**Memory as a first-class concern**
The WASM heap has a hard limit. Files larger than available memory are handled via streaming ingest and OPFS spill, degrading gracefully instead of crashing. Almost no frontend developer has done this, because on the web you normally never have to.

**Ingest**
A 2GB file dragged in must stream, chunk, infer types, surface malformed rows, and show progress — without blocking. Proper use of the File System Access and Streams APIs.

**Editor**
SQL autocomplete driven by the actual loaded schema, error surfacing, query history.

**Persistence**
OPFS-backed sessions so a reload doesn't lose work.

### The contrast worth holding onto

A CRUD dashboard makes an API call and renders a list — React handles the hard part. Here React is barely relevant. You're deciding what crosses the thread boundary, what stays in WASM memory, and what reaches the DOM. Get those wrong and the app doesn't render slowly; it dies.

Worker orchestration, memory management, and rendering performance are the three things that separate senior frontend from competent frontend — and none of them can be faked with a library.

---

## 4. Technical shape

**Core stack**
- DuckDB-WASM (query engine, in a Web Worker)
- OPFS (Origin Private File System) for persistence and spill
- Web Workers for parsing and ingest
- Custom virtualized grid (no off-the-shelf table library — that's the point)
- Static hosting

**Architecture sketch**

```
Main thread          │  Worker(s)
─────────────────────┼──────────────────────────
UI / grid render     │  DuckDB-WASM instance
Editor + autocomplete│  File parse + type inference
Viewport state       │  Query execution
Selection / input    │  Result serialization
        ↕ transferable objects, cancellation-aware protocol
                     ↓
                   OPFS (persistence + spill)
```

**Hard problems, listed honestly**
1. Virtualization that survives variable row heights + column resize + streaming inserts simultaneously
2. Cancellation semantics — a user aborts a 30-second query, everything unwinds cleanly
3. Memory ceiling handling — detect pressure, spill, degrade, never crash the tab
4. Avoiding main-thread copies of large result sets
5. Type inference on messy real-world CSVs without blocking ingest

---

## 5. Measurability

This project's biggest interview advantage: everything is quantifiable.

- Time to first row
- Memory ceiling before degradation
- Frame timing during scroll at 1M / 10M rows
- Ingest throughput (MB/s)
- Query latency distribution

*"The naive version dropped to 12fps at 500k rows — here's what I changed and here's the profile after"* is a conversation you simply cannot have about a CRUD app.

Capture profiles before and after each optimization. They are the deliverable as much as the app is.

---

## 6. Scope

### V1 — the honest minimum
- Drag-and-drop CSV ingest with streaming + progress
- Type inference
- SQL editor (basic, no autocomplete yet)
- Virtualized results grid
- Worker-based DuckDB execution
- Query cancellation

### V2 — the differentiators
- Schema-driven SQL autocomplete
- OPFS persistence / session restore
- Parquet support
- Malformed row surfacing and repair
- Column stats / profiling panel

### V3 — optional surface expansion
- Chart layer rendering from query results (adds canvas rendering without a second project)
- Multi-file joins
- Export (CSV / Parquet / clipboard)

### Explicitly out of scope
- Any backend
- Any AI/inference
- Collaboration / multiplayer
- Auth, accounts, billing

---

## 7. Next step

Move into the IDE. First decisions to make there:

1. Repo and build setup (worker bundling is the first real constraint — it shapes the toolchain choice)
2. Worker/main-thread message protocol design **before** any UI
3. DuckDB-WASM instantiation + a single hardcoded query proving the round trip
4. Ingest pipeline
5. Grid last — it's the most work but the least uncertain

Build the risky, uncertain parts first. The grid is months of work but nothing in it is unknown; the worker boundary and memory behavior are where surprises live.
