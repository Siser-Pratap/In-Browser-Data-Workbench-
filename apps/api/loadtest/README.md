# Load tests

Backend Phase 3, acceptance criterion 6. Requires [k6](https://k6.io) — or run it
in Docker, no install needed.

## Running

Start the API against a real PostgreSQL (SQLite will not tell you anything
useful about concurrency), with the auth rate limiter raised — every virtual
user signs up from the same IP, so the default 10/minute would reject nearly
all of them:

```bash
RATE_LIMIT_AUTH_PER_MINUTE=100000 \
DATABASE_URL=postgresql+asyncpg://workbench:workbench@localhost:5432/workbench \
JWT_SECRET=$(openssl rand -hex 32) \
uv run uvicorn app.main:app --app-dir src --host 0.0.0.0 --port 8010 --workers 4
```

Then:

```bash
# installed k6
BASE_URL=http://localhost:8010 VUS=200 k6 run loadtest/snapshot.js

# or via Docker
docker run --rm -i -e BASE_URL=http://host.docker.internal:8010 -e VUS=200 \
  grafana/k6 run - < loadtest/snapshot.js
```

## Measured (2026-07-21)

MacBook, PostgreSQL 16 in Docker, API on the same machine — so these say more
about a laptop than about production. Treat them as a baseline to detect
regressions against, not as a capacity model.

| Setup | Throughput | save p95 | read p95 | Failures |
|---|---|---|---|---|
| 200 VUs, 1 uvicorn worker | 74 req/s | 5.73 s | 5.20 s | 0 / 7901 |
| 200 VUs, 4 uvicorn workers | 112 req/s | 3.00 s | 2.31 s | 0 / 11911 |

What this establishes:

- **Correctness holds under saturation.** Zero failed requests and zero business
  errors at 200 concurrent users; every snapshot read back had all 50 queries.
  The service degrades in latency, not in correctness.
- **Throughput scales with workers**, sub-linearly (1.5x for 4x workers) — past
  one worker the bottleneck moves to PostgreSQL and the connection pool, which
  is where a real capacity exercise should look next.
- The latency thresholds in the script are deliberately loose. The plan's
  "p95 < 150 ms for a snapshot GET" is an *unloaded* budget, asserted by
  `tests/test_performance.py` (~12 ms against PostgreSQL). Holding a
  single-request budget while 200 users hammer one box would just be a
  threshold nobody trusts.

Not yet measured: the compute-job half of the criterion (20 concurrent
server-compute jobs), which needs real uploaded datasets in S3/MinIO.
