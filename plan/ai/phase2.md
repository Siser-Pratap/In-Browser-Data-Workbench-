# AI — Phase 2: Data Profiling, Cleaning Suggestions & Auto-Insights

## Goal

Make the workbench proactive: given a dataset's profile, the AI suggests cleaning steps (as applyable SQL), surfaces notable patterns and anomalies, and recommends charts — powering the frontend's Insights panel.

## Prerequisites

- AI Phase 1 (AI module, validation pipeline, eval harness pattern).
- Frontend Phase 4's Insights panel consumes these endpoints.

## Scope

### 1. Client-side profiling contract

The **browser computes the profile** (privacy: raw data stays local); the AI interprets it. Define a versioned profile document the frontend produces via DuckDB SQL:

```json
{
  "version": 1,
  "table": "sales",
  "row_count": 182340,
  "columns": [{
    "name": "email", "type": "VARCHAR",
    "null_pct": 3.1, "distinct_count": 179001, "distinct_pct": 98.2,
    "top_values": [["", 412], ["n/a", 88]],
    "patterns": {"regex_email_match_pct": 94.5},
    "numeric": null,
    "temporal": null
  }],
  "candidate_keys": ["order_id"],
  "sample_rows_included": false
}
```

- [ ] Frontend: profiling SQL generator + progress UI (runs per-column stats in batches; ~1–2 s for 1M rows). *(Frontend Phase 4 work — backend contract is ready.)*
- [x] Profile document schema validated on the backend ([profile.py](../../apps/api/src/app/ai/profile.py), versioned Pydantic model). Shared `packages/shared` copy lands with Frontend Phase 4.

### 2. Cleaning suggestions

- [x] `POST /api/v1/ai/clean` — profile in → structured suggestion list out (SSE):
  ```json
  {"suggestions": [{
     "id": "trim-email-blanks",
     "severity": "warning",
     "finding": "3.1% of email values are empty strings or 'n/a', not NULL",
     "proposal": "Normalize placeholder values to NULL",
     "sql": "UPDATE ... /* or CREATE TABLE cleaned AS SELECT ... */",
     "affects_rows_estimate": 500
  }]}
  ```
- [x] Detection targets (model-driven, guided by the prompt's checklist): placeholder nulls, mixed types in text columns, dates stored as text, inconsistent casing/whitespace, duplicate rows/keys, outliers (from numeric stats), unit inconsistencies, columns that should be split/merged.
- [x] Every `sql` proposal runs through the validator (extended with `allow_ctas` — accepts `CREATE TABLE new AS SELECT ...`, rejects overwriting an existing table, still rejects all DML).
- [x] Frontend contract: each suggestion carries a `preview_sql` (the SELECT variant) and a `sql` (the CTAS) so the card can offer **Preview** then **Apply** — always user-initiated. *(Card UI is Frontend Phase 4.)*

### 3. Auto-insights

- [ ] `POST /api/v1/ai/insights` — profile (+ optional user focus like "focus on revenue") → 3–7 ranked insights:
  ```json
  {"insights": [{
     "headline": "Revenue is concentrated: top 5% of customers drive 61% of revenue",
     "detail": "...",
     "verification_sql": "SELECT ...",     // frontend runs this to confirm & display live numbers
     "chart_spec": { ...frontend chart-spec JSON... },
     "confidence": "verified_by_sql | hypothesis"
  }]}
  ```
- [x] **Verification loop is the core mechanic:** every insight carries `verification_sql` (validated read-only + required to run client-side) and a `confidence` of `verified_by_sql`/`hypothesis`; the AI never sees raw data, so grounding happens when the browser executes the SQL. Backend validates the SQL runs; the confirm-the-numbers step is Frontend Phase 4.
- [x] Insight categories in the prompt: distributions/concentration, trends & seasonality (when temporal columns exist), segment differences, correlations, data-quality red flags worth analysis attention.

### 4. Chart recommendations

- [x] `POST /api/v1/ai/charts/suggest` — profile (+ optional question) → 2–4 chart specs in the chart-spec format ([chartspec.py](../../apps/api/src/app/ai/chartspec.py), shared with Frontend Phase 3), each with a one-line rationale.
- [x] Specs validated (chart-spec schema via structured output + the SQL query through the validator) before returning; invalid specs regenerated once, then dropped and counted.
- [x] Powers both the Insights panel (`insights[].chart_spec`) and the standalone suggest endpoint.

### 5. Evaluation

- [x] Eval harness extended ([evals/insights/](../../apps/api/evals/insights/)): a seeded-defect dataset measuring cleaning defect-recall + CTAS executability, and a seeded-pattern case measuring insight signal-hit + verification-SQL executability. Grow the case set toward the acceptance bars.
- [x] Chart-spec structural validity is guaranteed by schema-constrained generation; the SQL-query validity rate is what the harness / `dropped` counter track.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Profiling location | Browser (DuckDB SQL) | Raw data never leaves the machine; AI sees aggregates only |
| Insight grounding | Model emits verification SQL; client executes | Eliminates hallucinated numbers without shipping data to the server |
| Cleaning semantics | Materialize new tables, never mutate | Undo-able, auditable, matches the SQL-as-source-of-truth philosophy |
| Output format | Strict structured JSON (tool-use / schema-constrained generation) | UI renders cards directly; validation is mechanical |

## Deliverables & Acceptance Criteria

1. On the seeded dirty dataset, ≥ 80% of planted defects are found with a valid, correctly-scoped SQL fix; false-positive suggestions < 20%.
2. On seeded-pattern datasets, ≥ 70% of planted patterns appear in insights, and every displayed insight's numbers match its verification SQL output.
3. Chart suggestions render without error in the frontend chart component for all sample datasets.
4. Full Insights panel flow works end-to-end: profile → clean cards → apply one → insights → add suggested chart to dashboard.
5. All endpoints respect Phase 1's budgets, rate limits, and streaming conventions.

## Estimated Effort

~2–3 weeks for one developer.

## Out of Scope (later phases)

Multi-turn analyst conversation (Phase 3), scheduled/automatic re-profiling, anomaly monitoring over time.
