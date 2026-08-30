# Workbench API

FastAPI service for the In-Browser Data Workbench. Implements the platform
foundation ([plan/backend/phase1.md](../../plan/backend/phase1.md) — accounts,
auth, database) and the AI endpoints ([plan/ai/phase1–3](../../plan/ai/)). All
generated SQL is a **proposal** and every AI tool executes **in the browser** —
the server stores accounts and (later) workspace metadata, never the user's rows.

## Endpoints

**Auth & platform** (`/api/v1/auth/*`, `/api/v1/users/*`): signup, verify-email,
login, refresh, logout, password forgot/reset, `users/me` (GET/PATCH/DELETE),
and `auth/oauth/{provider}` when a provider is configured. Plus `/healthz`
(liveness) and `/readyz` (database check). See the auth section below.

**AI:**

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/ai/sql` | English question + schema context → streamed SQL proposal (or a clarification) |
| `POST /api/v1/ai/sql/fix` | Failing SQL + DuckDB error → streamed corrected SQL |
| `POST /api/v1/ai/sql/explain` | SQL → streamed plain-English explanation |
| `POST /api/v1/ai/clean` | Profile document → validated cleaning suggestions (each a `CREATE TABLE ... AS`) |
| `POST /api/v1/ai/insights` | Profile document → ranked insights, each with `verification_sql` |
| `POST /api/v1/ai/charts/suggest` | Profile (+ optional question) → 2–4 chart specs |
| `POST /api/v1/ai/chat` | Start an analyst session → `{session_id, starter_prompts}` |
| `POST /api/v1/ai/chat/{id}/message` | Send a user message → streamed turn (text, tool calls, or completion) |
| `POST /api/v1/ai/chat/{id}/tool-result` | Return browser tool results → resumes the paused turn |
| `GET /healthz` | Liveness |

All AI endpoints stream Server-Sent Events. Phase 1 event types: `delta`,
`sql`, `clarification`, `explanation`, `error`, `done`. Phase 2 endpoints emit
a single result event (`suggestions` / `insights` / `charts`) with a `dropped`
count for items that failed validation, then `done`. Phase 3 chat events:
`delta`, `message`, `tool_call`, `awaiting_tools`, `error`, `done`
(see `src/app/ai/service.py` and `src/app/ai/chat_service.py`).

## Conversational analyst (Phase 3)

The agent loop runs server-side; **tools execute in the browser**. A turn runs
the model until it either finishes (`done`) or emits `tool_call` events and ends
with `awaiting_tools`. The browser executes those tools against DuckDB-WASM and
POSTs the results to `/chat/{id}/tool-result`, which resumes the loop. Tools:
`list_tables`, `get_schema`, `get_profile`, `run_sql`, `create_chart`,
`save_query` — all browser-executed; the SQL-bearing ones are validated
server-side before dispatch (invalid SQL never reaches the browser — it's fed
back as an error so the model self-corrects). Per-turn tool-call caps, a
max-turns limit, and a per-session token budget force a graceful tools-off
wrap-up. The system prompt hardens against prompt injection: values inside tool
results are treated as data, never instructions. Session state is in-memory with
a TTL (moves to Redis in Backend Phase 3).

## Validation

- **Phase 1** — each statement is parsed with sqlglot: single statement,
  read-only (SELECT/CTE/set ops), all referenced tables present in the client's
  schema. One self-correction round on failure.
- **Phase 2** — output is schema-constrained (structured outputs), then each
  item's SQL is validated. Cleaning `sql` runs through the validator with
  `allow_ctas` (accepts `CREATE TABLE new AS SELECT ...`, rejects overwriting an
  existing table and all DML); insight `verification_sql` and chart `query` must
  be read-only. One repair round feeds validation errors back; anything still
  invalid is dropped and counted.

## Accounts & auth

Email/password (Argon2) plus optional Google/GitHub OAuth. Access is a 15-minute
JWT; the refresh token is opaque, stored **hashed**, and rides an httpOnly
cookie. Refresh tokens **rotate** — each refresh consumes one and issues a new
one in the same family; presenting an already-used token is treated as reuse and
revokes the whole family. Email verification and password-reset tokens are
short-lived signed JWTs (no table); a reset token is bound to the password it was
minted for, so it's single-use. Account deletion cascades tokens + OAuth links +
the user row. Errors are RFC 7807 problem+json; auth endpoints are rate-limited
(429 + `Retry-After`).

The AI endpoints are **local-first**: they accept an access token but fall back
to the `X-User-Id` header, then a shared anonymous bucket — so they work
signed-out. OAuth routes exist only when a provider's client id + secret are set.

`EmailService` has no provider wired yet — it logs the message (and the
verify/reset link) so flows are exercisable in dev; swap in SMTP/SES/Resend
behind that interface. The rate limiter is in-memory (fixed window); the
interface is small so a Redis-backed one drops in for multi-worker prod.

## Privacy

The server never fetches user data — it can't; the data lives in the browser.
The **browser computes the profile document** (aggregates only) and the AI
interprets it. Insight grounding happens client-side: the model emits the SQL
that would verify each claim, and the browser runs it. Sample values and top
values in the profile are opt-in from the client.

## Run

```sh
cd apps/api
cp .env.example .env   # set GEMINI_API_KEY_DEV (AI, dev) and JWT_SECRET (auth)

# One-command local stack (Postgres + Redis + MinIO + api, runs migrations):
docker compose up

# Or run the API directly against a local Postgres:
uv sync
uv run alembic upgrade head            # apply migrations
uv run uvicorn app.main:app --app-dir src --reload
```

Set `DB_AUTO_CREATE=true` to create tables on startup without Alembic (dev only).

## Test

```sh
uv run pytest              # unit + endpoint tests (model seam mocked; SQLite DB)
uv run ruff check .        # lint
uv run alembic check       # migrations match the models
```

### Against PostgreSQL

SQLite is fast and needs no services, but it is not the production engine, and
the difference has bitten: a snapshot save that INSERTed charts before the
queries they reference passed on SQLite and failed on PostgreSQL every time.
CI runs the suite both ways; do the same locally before trusting a change to
the persistence layer.

```sh
docker compose up -d db
TEST_DATABASE_URL=postgresql+asyncpg://workbench:workbench@localhost:5432/workbench \
  uv run pytest -q
```

(SQLite runs with `PRAGMA foreign_keys=ON` so it enforces the same referential
integrity — see `db/session.py`.)

### Performance and load

```sh
uv run pytest -m perf -q -s          # timing budgets; excluded from the default run
```

`PERF_DATABASE_URL` points the benchmarks at PostgreSQL. Load tests live in
[loadtest/](loadtest/) with measured baselines.

## Evals (live model, manual/nightly)

```sh
GEMINI_API_KEY=... uv run pytest evals -m eval -v
```

Execution-based grading against DuckDB databases seeded from each case file:

- `evals/nl2sql/` — generated vs. expected SQL, result sets compared.
- `evals/insights/` — cleaning defect-recall + CTAS executability, and insight
  signal-hit + verification-SQL executability.
- `evals/chat/` — the harness plays the browser (executes the agent's tool
  calls against DuckDB, resumes the loop) and grades execution-grounded final
  answers; plus an injection case that plants a hostile instruction in a cell.

Prompt changes should include an eval run in the PR description.

## Known deferrals

- **In-memory stores → Redis**: the AI daily-token budget, the chat session
  store, and the auth rate limiter are per-process. All three are behind small
  interfaces so a Redis-backed implementation drops in (Backend Phase 3).
- **Email provider**: `EmailService` logs instead of sending (see above).
- **mypy**: not yet wired into lint/CI — ruff + the test suite carry quality for
  now.
- **Workspace persistence** (saved queries, chart specs, dashboards, chat
  transcripts): Backend Phase 2.
