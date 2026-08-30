# Backend — Phase 3: Server-Side Compute, Jobs & Production Readiness

## Goal

Handle what the browser can't: server-side query execution for very large files, background jobs (exports, purges), and the observability/deployment work needed to run the platform in production.

## Prerequisites

- Backend Phase 2 (datasets with uploaded storage, workspace APIs).

## Scope

### 1. Server-side query engine (big-file fallback)

The browser handles files up to roughly memory size; beyond that, users can opt into server compute on **uploaded** datasets.

- [x] Compute service using **server-side DuckDB** reading Parquet/CSV directly from S3 (`httpfs`), one ephemeral DuckDB instance per job — [compute/engine.py](../../apps/api/src/app/compute/engine.py). Each query also gets its own thread executor: DuckDB holds native state, and the default event-loop executor's lifetime is tied to the loop's — a loop shutting down under an in-flight query segfaults the process (observed, then fixed).
- [x] API — [routers/compute.py](../../apps/api/src/app/routers/compute.py):
  ```
  POST /api/v1/compute/queries          {workspace_id, dataset_ids, sql}  → 202 {job_id}
  GET  /api/v1/compute/queries/{job_id} → job status + result summary
  GET  /api/v1/compute/queries/{job_id}/result → expiring URL to the Arrow IPC bytes
  ```
  Bad SQL is rejected **synchronously on the POST** — the user shouldn't learn about a parse error via a job that fails a second later.
- [x] Safety rails: per-user concurrency limit (default 2), 60 s timeout that *interrupts* the connection rather than abandoning the thread, memory/thread caps, `LIMIT max_rows + 1` injection so "exactly full" is distinguishable from "truncated", and read-only enforcement.
- [x] Results as Arrow IPC, written to S3 and served via expiring links — the API never streams result bytes.
- [ ] Frontend contract: engine picker per dataset ("Browser" / "Server") — **backend side is ready; the picker is Frontend work.**

**On the SQL boundary.** [compute/sql_guard.py](../../apps/api/src/app/compute/sql_guard.py) is a separate module from [ai/validator.py](../../apps/api/src/app/ai/validator.py) on purpose. The AI validator filters SQL the *browser* will run on the user's own machine, so a miss costs quality. This guard decides what executes on our hardware with our storage credentials, so a miss is a breach. It is an **allowlist**: every `FROM` source must be a plain identifier bound into the session. That distinction matters concretely — `read_csv('/etc/passwd')` and `read_parquet('s3://other-tenant/…')` parse as a table node whose *name is the empty string*, so a name-based blocklist silently passes all of them. Both were verified leaking before the rewrite; [test_sql_guard.py](../../apps/api/tests/test_sql_guard.py) pins them. Defense in depth: the connection's configuration is locked before user SQL runs, so a parser bypass still can't re-point S3 credentials.

### 2. Background job system

- [x] Worker framework: **ARQ** — [workers/worker.py](../../apps/api/src/app/workers/worker.py), run with `uv run arq app.workers.worker.WorkerSettings`. Verified end to end against a real Redis: enqueue → worker → task → status.
- [x] Jobs: compute queries, soft-delete purge (30-day, incl. the S3 objects), orphaned-upload cleanup, **usage-metering rollups** (`usage_daily`, migration `0004`) and finished-job expiry — [workers/tasks.py](../../apps/api/src/app/workers/tasks.py), scheduled by staggered crons (the rollup deliberately precedes the job-expiry sweep, which prunes the rows it reads). *(Export rendering is still not built: it needs Frontend Phase 3's render path to exist first.)*
- [x] Job table with status transitions, retry with exponential backoff, dead-letter marking. **The retry path was broken on first delivery** — `mark_failed` set the row back to `queued` but nothing re-enqueued it, so a retryable failure sat there forever, never retried, never dead-lettered, still holding a concurrency slot. `backoff_seconds` being dead code was the tell. Fixed, with a regression test that asserts the re-enqueue and its backoff. **The database row is the source of truth, not Redis** — a broker flush loses pending work but never job history, and ARQ's own retry is disabled (`max_tries=1`) so there is exactly one retry authority. Failures that will recur identically (rejected SQL, missing dataset) are classified non-retryable rather than burning three attempts.
- [x] `GET /api/v1/jobs/{id}` + SSE `GET /jobs/{id}/events` — [routers/jobs.py](../../apps/api/src/app/routers/jobs.py). The stream polls on short-lived sessions; holding the request's session open for the stream's lifetime would pin a pool connection.
- [x] **Runs without Redis.** `create_queue` falls back to an in-process queue when the broker is unreachable, so `docker compose up` with no worker still executes jobs — loudly logged, because in production it means jobs are running on the API process.

### 3. Observability

- [ ] OpenTelemetry traces (FastAPI + SQLAlchemy + httpx instrumentation) exported OTLP; Sentry for error tracking. — **needs a collector endpoint and Sentry DSN to be worth wiring.**
- [x] Prometheus metrics at `/metrics` — [core/metrics.py](../../apps/api/src/app/core/metrics.py): request latency histograms, job counts/duration by kind, queue depth, compute result sizes, LLM token counter. Route labels use the path *template*, never the concrete path, or every workspace id becomes its own time series. Queue depth is read live rather than tracked incrementally, so a restarted process doesn't report a counter that never matches reality.
- [x] Log correlation: request id → job id. The API stamps the originating request id into the job row, and the worker restores it into its log context, so `X-Request-ID` → `job.params.request_id` → `job_id` joins the whole chain. (Trace ids join in with OTel, above.)
- [x] `/readyz` reports the job-queue mode (`redis` / `inline` / `inline_fallback`). It does **not** gate readiness on Redis — an unreachable broker degrades to in-process jobs, which is worth alerting on but is not a reason to pull the instance from the load balancer. Previously that fallback was invisible.
- [ ] Alert definitions (as code) — **the metrics they'd read now exist; the rules belong with the deployment target.**

### 4. Security & compliance hardening

- [x] Dependency audit in CI (`pip-audit`, advisory) — [.github/workflows/api.yml](../../.github/workflows/api.yml). *(`npm audit` belongs to the frontend workflow; Docker image scanning wants a registry.)*
- [x] Secrets via environment only; nothing baked into images.
- [x] Data-retention & deletion guarantees tested: account deletion purges the S3 objects, not just the rows that reference them. Doing it explicitly rather than via FK cascade is deliberate — the cascade would drop the rows *holding the storage keys* and strand the files.
- [ ] `/security-review` before go-live; pentest checklist for share-token and presigned-URL surfaces. — **user-triggered.**

### 5. Deployment & operations

The image and the load test are done. The rest needs decisions or credentials that aren't in the repo — which host, which registry, which staging database:

- [x] Production Dockerfile: multi-stage, non-root (uid 10001), `--proxy-headers`, `WEB_CONCURRENCY` worker knob, liveness `HEALTHCHECK` on `/healthz` (not `/readyz` — a database blip shouldn't make the orchestrator kill a healthy container). Image builds and both entry points verified inside it. Compose runs an `api` **and** a `worker` service.
- [ ] Deploy targets: API + worker containers, managed Postgres + Redis, S3/R2 — **target undecided.**
- [ ] GitHub Actions CD: build → migrate (gated) → deploy api → deploy worker; rollback procedure.
- [ ] Staging environment with seeded demo data + smoke tests on every deploy.
- [~] Load test (k6): [loadtest/snapshot.js](../../apps/api/loadtest/snapshot.js) + [measured baselines](../../apps/api/loadtest/README.md). At 200 VUs against PostgreSQL: **zero failures across 11,911 requests**, 112 req/s on 4 uvicorn workers (74 on 1), p95 latency 2.3–3.0 s under saturation. Correctness holds under load; throughput scales sub-linearly with workers, so the next bottleneck is PostgreSQL and the connection pool. The compute-job half (20 concurrent jobs) still needs real uploaded datasets in S3/MinIO.
- [ ] Runbook: on-call basics, common failures, restore-from-backup drill (Postgres PITR verified once).

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Server engine | DuckDB (server-side) over Spark/warehouse | Same SQL dialect as the browser engine — queries are portable both ways; zero-ops |
| Job queue | ARQ on Redis | Async-native, minimal infra, Redis already present |
| Result format | Arrow IPC pages | Identical consumption path as browser results; no dual grid code |
| Isolation | Ephemeral engine per job + caps | Multi-tenant safety without container-per-query complexity |

## Deliverables & Acceptance Criteria

1. [~] Server compute returns Arrow that the grid consumes, end to end (request → job → S3 → expiring link), tested. **Not yet proven at 5 GB** — needs a real MinIO/S3 fixture at that scale.
2. [x] A runaway query (cartesian join) is killed at the timeout and reported cleanly as `query_timeout`; each job gets its own engine and executor, so others are unaffected.
3. [x] Job lifecycle covered by integration tests: queue → run → result, retry → dead-letter, cancel-before-start, concurrency cap, SSE progress → done.
4. [ ] Traces spanning frontend → API → worker → S3 — request/job log correlation is in place; distributed tracing awaits OTel.
5. [ ] Staging deploy + rollback drill — not started (no target).
6. [~] Load test written and run — 200 VUs, zero failures, baselines recorded in [loadtest/README.md](../../apps/api/loadtest/README.md). Run on a laptop, so it establishes correctness-under-load and a regression baseline, not a production capacity model. Restore-from-backup drill not started (no environment).

Status: **182 tests pass on both SQLite and PostgreSQL**, `ruff` clean, `alembic upgrade head` + `alembic check` clean, the ARQ worker verified against a live Redis (enqueue → worker → task → status), and the production image built and run.

## Bugs found in the audit pass

- **Retries never retried** (see §2 above) — the most serious: silent, and it
  permanently consumed the user's concurrency budget.
- **Rate limiter leaked memory**: one dict entry per client IP, never evicted.
- **`rate_limit_default_per_minute` was dead config** — every call site passed
  `auth=True`, so the expensive endpoints (compute, AI) had no per-IP limit at
  all. Now applied to both.
- **AI routes had no stable `operation_id`s**, so any handler rename silently
  renamed methods in the generated TypeScript client.
- **A DuckDB/PyArrow import on a worker thread segfaulted the interpreter.**
  Both are heavyweight C extensions and the query body runs off-thread; letting
  a thread trigger their *first* import crashed the process reproducibly. They
  are imported at module scope now, while still single-threaded.

## Estimated Effort

~3–4 weeks for one developer.

## Out of Scope

Warehouse connectors (BigQuery/Snowflake), scheduled data refresh, multi-region — post-launch roadmap.
