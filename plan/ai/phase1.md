# AI — Phase 1: Natural Language → SQL Engine

## Goal

A backend AI service that turns an English question plus the user's table schemas into correct, safe DuckDB SQL — streamed to the frontend's "Ask AI" bar — plus a fix-my-query variant for SQL errors.

## Prerequisites

- Backend Phase 1 (the AI endpoints mount into the FastAPI app; API key must stay server-side).
- Consumed by Frontend Phase 4's Ask-AI UI.

## Scope

### 1. AI service module

- [x] `apps/api/src/app/ai/` module: provider client (Google Gen AI SDK), prompt templates, schema serializer, SQL validator, endpoints.
- [x] Model strategy: `gemini-2.5-flash` as default (configurable thinking level for the latency/quality tradeoff); all model IDs in config, never hardcoded.
- [x] Cost controls from day one: per-user daily token budget (in-memory; moves to Redis with Backend Phase 1), per-request `max_tokens`, prompt-cached system prompt, token usage recorded per request (feeds the metrics in Backend Phase 3).

### 2. Schema context pipeline

The quality ceiling of NL→SQL is the schema context. The frontend sends (user-visible and toggleable):

```json
{
  "question": "monthly revenue by region for 2025",
  "tables": [{
    "name": "sales",
    "columns": [{"name": "sold_at", "type": "TIMESTAMP"}, ...],
    "row_count": 182340,
    "samples": {"region": ["EMEA", "APAC"], ...},        // optional, off by default
    "column_stats": {"sold_at": {"min": "...", "max": "..."}}  // optional
  }],
  "dialect": "duckdb"
}
```

- [x] Schema serializer: compact `CREATE TABLE`-style rendering + enum-like sample values; hard cap on context size with priority truncation (drop stats → drop samples → truncate wide tables).
- [x] Privacy: sample values are **opt-in from the client**; server never fetches user data itself (it can't — data is in the browser). Document this clearly in the endpoint description.

### 3. Prompting & generation

- [x] System prompt: DuckDB dialect rules (e.g., `date_trunc`, `LIST`/`STRUCT` types, no backticks), formatting conventions, "return one SQL statement in a fenced block + one-line explanation".
- [x] Few-shot examples covering: aggregation+time bucketing, joins, window functions, "top N per group" (pivot examples still to add).
- [x] Ambiguity handling: if the question is ambiguous (column could mean two things), the model asks one short clarifying question instead of guessing — structured as a distinct response type (`clarification` SSE event) the UI renders.
- [x] Streaming via SSE end-to-end (Gemini stream → FastAPI `StreamingResponse` → frontend).

### 4. Validation & safety

- [x] Post-generation validation before returning "ready": parse with `sqlglot` (duckdb dialect) — syntax check, statement-type check (SELECT/CTE only; reject DDL/DML/PRAGMA/COPY), and referenced tables must exist in the provided schema (column-level checking still to add).
- [x] On validation failure: one automatic self-correction round (feed the error back), then surface the failure honestly.
- [x] The API returns SQL as a **proposal**; execution always happens client-side on user action (frontend contract).

### 5. Endpoints

```
POST /api/v1/ai/sql            question + schema ctx     → SSE: sql | clarification | error
POST /api/v1/ai/sql/fix        sql + error + schema ctx  → SSE: fixed sql + note
POST /api/v1/ai/sql/explain    sql + schema ctx          → SSE: plain-English explanation
```

- [ ] Auth-required, rate-limited (tighter than normal endpoints), token-budget-enforced with clear 429/402-style error bodies the UI can render. *(Partial: token budget enforced with 429s; identity is an `X-User-Id` placeholder and per-route rate limiting waits on Backend Phase 1.)*

### 6. Evaluation harness (small but real)

- [ ] `apps/api/evals/nl2sql/`: ~60 curated (schema, question, expected-result) cases over 3 sample datasets (not expected-SQL — grade by executing both against DuckDB and comparing result sets). *(Harness built with execution-based grading; 6 seed cases so far — grow toward 60.)*
- [x] `pytest -m eval` runs the harness against the live model (manual/nightly, not per-PR); score report checked into the repo per run.
- [ ] Acceptance bar tracked over time; prompt changes require an eval run in the PR description.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Where AI runs | Backend only | API key security, budgets, one place to observe cost |
| Validation | sqlglot parse + allowlist + schema check | Catches most bad generations before the user sees them |
| Grading | Execution-based (result-set compare) | SQL string similarity is meaningless; results are the truth |
| Clarification path | First-class response type | Better UX than confidently wrong SQL |

## Deliverables & Acceptance Criteria

1. Eval harness scores ≥ 80% execution-correct on the curated set for single-table questions, ≥ 65% on joins.
2. All three endpoints stream, validate, and enforce budgets; DDL/DML injection attempts in the question are refused (tested with adversarial cases).
3. Ambiguous question produces a clarification response the frontend can render.
4. p50 time-to-first-token < 1.5 s from the frontend (with prompt caching warm).
5. Token usage per request visible in logs/metrics; a user hitting their daily budget gets a clean, explained error.

## Estimated Effort

~2–3 weeks for one developer.

## Out of Scope (later phases)

Data profiling and insights (Phase 2), multi-turn chat with tool use (Phase 3), fine-tuning.
