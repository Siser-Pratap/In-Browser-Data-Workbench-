# Backend — Phase 1: Foundation (FastAPI, Auth, Database)

## Goal

A production-shaped FastAPI service with authentication, user management, database migrations, and a Dockerized local dev environment — the platform every later backend and AI feature builds on.

## Prerequisites

- None on other tracks; runs in parallel with Frontend Phase 1.

## Scope

### 1. Project scaffolding

- [x] `apps/api` with FastAPI, Python 3.12, `uv` for dependency management.
- [x] Layered structure (routers → services → models); Pydantic v2 schemas separate from SQLAlchemy models.
- [x] Settings via `pydantic-settings` (env-driven; `.env.example` committed).
- [x] Tooling: `ruff` (lint), `pytest` + `pytest-asyncio`, FastAPI `TestClient`. The project isn't installed as a package, so `[tool.pytest.ini_options] pythonpath = ["src"]` puts the source root on `sys.path`. *(mypy not yet wired — a follow-up; ruff + the test suite carry Phase 1.)*
- [x] `docker-compose.yml`: api + PostgreSQL + Redis + MinIO (S3-compatible) for one-command local dev.
- [x] GitHub Actions CI ([.github/workflows/api.yml](../../.github/workflows/api.yml)): lint, migration-matches-models check, tests against a real Postgres service container.

### 2. Database layer

- [x] SQLAlchemy 2.0 (async, `asyncpg`) + Alembic wired from day one ([alembic/](../../apps/api/alembic/), initial migration `0001`).
- [x] Base model conventions: UUID primary keys, `created_at`/`updated_at`, soft-delete field on users. Generic column types so the same models run on Postgres (prod) and SQLite (tests).
- [x] Initial tables: `users`, `refresh_tokens`, `oauth_accounts`.

### 3. Authentication & users

- [x] Email + password auth: signup (with email-verification token flow), login, password reset. Argon2 hashing; login timing equalized so it doesn't leak whether an email exists.
- [x] OAuth: Google + GitHub via `authlib` with account-linking-by-email ([oauth_service.py](../../apps/api/src/app/services/oauth_service.py)). Routes register only when a provider's credentials are set; the linking logic is unit-tested, live provider HTTP is not.
- [x] Tokens: 15-min JWT access token + rotating refresh token in an httpOnly (secure, SameSite) cookie; presenting an already-rotated token is detected as reuse and revokes the whole family.
- [x] Endpoints (mounted under `/api/v1`): `signup`, `verify-email`, `login`, `logout`, `refresh`, `password/forgot`, `password/reset`, `auth/oauth/{provider}` + callback (when configured), `users/me` GET/PATCH/DELETE.
- [x] `current_user` dependency (401 without a token) + `optional_user_id` variant the AI endpoints use (token → header → anonymous), so they still work signed-out.
- [x] Account deletion is a real cascade delete (tokens + OAuth links + user row).

### 4. Platform plumbing

- [x] CORS locked to the configured frontend origins.
- [x] Rate limiting on auth endpoints returning 429 + `Retry-After`. *(In-memory fixed-window for now; the interface is small so a Redis-backed limiter drops in — noted in [ratelimit.py](../../apps/api/src/app/core/ratelimit.py).)*
- [x] Structured JSON logging with a per-request id (echoed as `X-Request-ID`); errors return RFC 7807 problem+json.
- [x] `/healthz` (liveness) and `/readyz` (checks the database) endpoints.
- [x] OpenAPI: tags + stable `operationId`s on the auth/users routes — the schema exports cleanly for the frontend client generator in Frontend Phase 4.

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| ORM | SQLAlchemy 2 async | De-facto standard, Alembic ecosystem |
| Auth model | JWT access + rotating refresh cookie | Stateless request auth, revocable sessions, XSS-resistant refresh |
| Package manager | `uv` | Fast, lockfile-based, single tool |
| Object storage from day 1 (MinIO) | Yes, in compose | Phase 2 file features land without infra rework |
| API versioning | Path prefix `/api/v1` | Simple, explicit |

## Directory Sketch

```
apps/api/
├── src/app/
│   ├── main.py             # app factory, middleware, router mounting
│   ├── core/               # settings, security, logging, deps
│   ├── db/                 # engine, session, base, alembic/
│   ├── models/             # user.py, token.py
│   ├── schemas/            # pydantic request/response
│   ├── routers/            # auth.py, users.py, health.py
│   └── services/           # auth_service.py, email_service.py
├── tests/
├── docker-compose.yml
└── pyproject.toml
```

## Deliverables & Acceptance Criteria

1. `docker compose up` gives a working API + Postgres + Redis + MinIO; `alembic upgrade head` runs clean.
2. Full auth lifecycle passes integration tests: signup → verify → login → authed request → refresh → logout; plus password reset and Google OAuth (mocked provider in tests).
3. Refresh-token reuse is detected and revokes the session family (tested).
4. Rate limiting returns 429 with `Retry-After` on auth endpoints (tested).
5. OpenAPI schema exports cleanly and `openapi-typescript` generates a client from it without errors.
6. CI green: ruff, mypy (strict on `src/app`), pytest ≥ 85% coverage on auth/services.

## Estimated Effort

~2–3 weeks for one developer.

## Out of Scope (later phases)

Workspace/data APIs (Phase 2), background jobs and server-side compute (Phase 3), AI endpoints (AI Phase 1 — they mount into this app).
