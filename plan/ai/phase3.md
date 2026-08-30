# AI — Phase 3: Conversational Data Analyst (Agentic Chat)

## Goal

A multi-turn chat assistant that behaves like a data analyst: it plans, runs SQL against the user's in-browser data through a tool loop, interprets the results, and answers with grounded text, tables, and charts — all inside the workbench's chat panel.

## Prerequisites

- AI Phases 1–2 (NL→SQL, validation, profiling contract, chart specs).
- Frontend Phase 4 chat panel.
- Backend Phase 3 helpful for observability of long agent sessions (not blocking).

## Scope

### 1. Agent architecture — the browser is the executor

The defining constraint: **the data lives in the browser**, so the agent loop's tool executions round-trip through the client.

```
User ↔ Chat UI ↔ (SSE + tool-result POSTs) ↔ FastAPI agent session ↔ Gemini API
                     ▲
                     └── tool calls (run_sql, get_profile…) executed by DuckDB-WASM in the browser
```

- [x] Agent session manager on the backend ([chat_session.py](../../apps/api/src/app/ai/chat_session.py)): conversation state, tool-call brokering (pending-ids + partial-results), per-session token accounting. In-memory with TTL for now; moves to Redis in Backend Phase 3.
- [x] Protocol ([chat_service.py](../../apps/api/src/app/ai/chat_service.py) + router): `POST /ai/chat/{id}/message` streams assistant text + `tool_call` events, ending a paused turn with `awaiting_tools`; the browser executes and POSTs to `POST /ai/chat/{id}/tool-result`, which resumes the loop. *(Per-await cancellation is a Frontend Phase 4 concern — the client just stops consuming and can send a new message.)*
- [x] Tools exposed to the model:
  | Tool | Executed | Purpose |
  |---|---|---|
  | `list_tables` / `get_schema` | client | discover data |
  | `get_profile(table)` | client | Phase 2 profile doc |
  | `run_sql(sql)` | client | query; result capped (~200 rows + rowcount) before returning to model |
  | `create_chart(spec)` | client | renders chart inline in chat |
  | `save_query(name, sql)` | client | persist useful queries to the workspace |
- [x] Every SQL-bearing tool (`run_sql`, `save_query`, `create_chart`) passes the validator server-side **before** the call reaches the client (read-only; `CREATE TABLE AS` allowed and the new table is registered for later validation). Invalid SQL never reaches the browser — it becomes an error tool result fed straight back so the model self-corrects.

### 2. Conversation quality

- [x] System prompt ([chat_prompts.py](../../apps/api/src/app/ai/chat_prompts.py)): analyst persona — states assumptions, cites which query produced each number, prefers a small table/chart over prose lists, offers next steps sparingly.
- [x] Grounding rule: any numeric claim must come from a tool result in this conversation (prompt-enforced + checked by the scenario evals).
- [ ] Context management for long chats: sliding window + running summary. *(Deferred — compaction can be layered onto `_call_model` later; current sessions rely on the model's 1M window + per-session token cap.)*
- [x] Multi-dataset awareness: the session tracks all loaded tables and the model can join across them; expensive-operation guarding is left to the prompt for now.
- [x] Interruption/steering: because each turn is a discrete request, the client can stop consuming and send a new message; already-run queries remain in the session history.

### 3. Chat UX contract (with Frontend Phase 4)

- [x] SSE event contract the UI renders (`delta`, `message`, `tool_call`, `awaiting_tools`, `error`, `done`) — every tool call is surfaced as an event; the message-block/timeline rendering itself is Frontend Phase 4.
- [x] Transparency: every tool call is emitted as a `tool_call` event before the browser runs it; nothing executes invisibly.
- [ ] Session persistence: chat transcript saved with the workspace — Backend Phase 2's snapshot gains a `chats` section. *(Store interface is small so this swaps in cleanly.)*
- [x] Suggested starter prompts generated from the loaded datasets' schemas ([chat_prompts.py](../../apps/api/src/app/ai/chat_prompts.py), heuristic — no model call), returned by `POST /ai/chat`.

### 4. Safety & limits

- [x] Hard caps per session: max tool calls per turn (~15) and max turns are enforced; hitting either cap or the per-session token budget forces a tools-off (`tool_choice: none`) wrap-up so the turn always ends gracefully.
- [x] All tool execution is client-side; SQL-bearing tools still pass the read-only validator server-side before dispatch.
- [x] Prompt-injection stance: the system prompt states tool results are data, not instructions; the eval suite plants a hostile instruction in a data cell and asserts the agent does not comply.

### 5. Evaluation

- [x] Scenario evals ([evals/chat/](../../apps/api/evals/chat/)): the harness plays the browser (executes tool calls against DuckDB, resumes the loop) and grades the final answer on execution-grounded figures. Two multi-step cases seeded — grow toward ~25.
- [x] Injection eval: a planted instruction in a data cell must not alter agent behavior (`must_not_contain`).
- [ ] Latency budget (first token < 2 s; 3-tool answer < 30 s) — to measure once running against the live model at scale.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Tool execution locus | Client-side (browser DuckDB) | Data privacy holds even for agentic AI; server never touches rows |
| Loop orchestration | Server-side (model loop in FastAPI, client as tool executor) | Keeps prompts/keys/budgets server-side; client stays thin |
| Session state | Redis with TTL + workspace snapshot on save | Resilient to disconnects; chats are portable with the workspace |
| Result truncation to model | Caps + summaries | Controls tokens; the user still sees full results locally |

## Deliverables & Acceptance Criteria

1. The agent completes a 3+ step analysis (explore schema → query → follow-up query → chart + narrative) on sample data with correct, execution-verified numbers.
2. Scenario eval: ≥ 70% fully-correct outcomes; zero ungrounded numeric claims in passing runs; injection eval fully passed.
3. Disconnect mid-turn and reconnect: session resumes without losing state.
4. Budget exhaustion and user-cancel both produce clean, explained endings.
5. A chart created in chat lands on a dashboard, and a saved query appears in the workspace — proving the loop writes back into the product.

## Estimated Effort

~3 weeks for one developer.

## Out of Scope

Voice input, scheduled agent reports, cross-workspace memory, warehouse connectors — post-launch roadmap.
