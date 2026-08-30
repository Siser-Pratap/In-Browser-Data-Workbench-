# Backend — Phase 2: Workspace Persistence & Sharing

## Goal

APIs that let signed-in users save their workbench to the cloud — workspaces, saved queries, chart specs, dashboards, dataset metadata, optional raw-file storage — and share workspaces via links.

## Prerequisites

- Backend Phase 1 (auth, DB, storage plumbing).
- Coordinates with Frontend Phase 4, which consumes these APIs.

## Scope

### 1. Data model

```
workspaces        id, owner_id, name, description, is_public, share_token,
                  settings(jsonb), created_at, updated_at, deleted_at
datasets          id, workspace_id, name, source_filename, format,
                  schema(jsonb: columns+types), row_count, byte_size,
                  storage_mode(enum: local_only | uploaded), storage_key nullable
queries           id, workspace_id, name, sql, position, created_at, updated_at
charts            id, workspace_id, query_id nullable, spec(jsonb), created_at, updated_at
dashboards        id, workspace_id, name, layout(jsonb: grid of chart refs)
workspace_members id, workspace_id, user_id, role(enum: viewer | editor)   -- v1: viewer only via links
activity_log      id, workspace_id, user_id, action, payload(jsonb), created_at
```

Notes:
- `datasets.storage_mode = local_only` is the default: the server stores **schema and metadata only**, never the rows. `uploaded` is an explicit user opt-in.
- Chart `spec` is the frontend's versioned chart-spec JSON (see Frontend Phase 3) — the backend treats it as opaque but schema-validates the envelope (`{version, type, ...}`).

Shipped in [db/models/workspace.py](../../apps/api/src/app/db/models/workspace.py), migration `0002`. Roles and storage modes are `String` columns rather than native DB enums, so the same models run on Postgres and on SQLite in tests; the allowed values are enforced by the Pydantic schemas on the write path. `settings`/`spec`/`layout` are JSONB on Postgres, plain JSON on SQLite.

### 2. Workspace CRUD APIs

- [x] `POST/GET/PATCH/DELETE /api/v1/workspaces` (+ list with pagination, sort by updated) — [workspaces.py](../../apps/api/src/app/routers/workspaces.py).
- [x] Nested resources: `/workspaces/{id}/datasets|queries|charts|dashboards` — full CRUD each. All four are the same four operations over a different model, so they're generated from one table in [workspace_children.py](../../apps/api/src/app/routers/workspace_children.py).
- [x] **Bulk sync endpoint** `PUT /workspaces/{id}/snapshot`: accepts the whole workspace document, diffs server-side, upserts atomically. Rows the client omits are deleted — with one exception: a dataset with `storage_mode = uploaded` is never dropped by a snapshot save, or a client that never saw the upload would orphan the S3 object.
- [x] Optimistic concurrency: ETag on snapshot GET, `If-Match` on save; 409 + `version_conflict` on divergence. The ETag is a hash of `(id, updated_at)` rather than the raw timestamp, so clients can't hand-craft a matching value.
- [x] Soft delete with 30-day retention + purge job hook (job runs in Phase 3). Deleting also drops the share token, so the link dies immediately.

### 3. File storage (opt-in raw data)

- [x] Presigned upload flow: `POST /datasets/{id}/upload-url` → client PUTs directly to S3/MinIO → `POST /datasets/{id}/upload-complete` — [datasets.py](../../apps/api/src/app/routers/datasets.py). Size and checksum come from `head_object`, not the client.
- [x] Presigned download URL endpoint for re-attaching data on another machine.
- [x] Per-user storage quota (default 1 GB) enforced at upload-url time *and* at complete (the real size can exceed what was declared); usage endpoint `GET /users/me/usage`.
- [x] Server-side encryption at rest (SSE-S3) on the signed PUT; starting a new upload deletes the object the dataset previously pointed at. *(The S3 lifecycle rule for uploads that are started but never completed is infrastructure, not app code — it belongs with the bucket definition.)*
- [x] Extension allowlist (csv, tsv, json, parquet, xlsx) and max single-file size (default 2 GB).
- [x] Storage is optional: with `S3_BUCKET` unset the endpoints return 503 and the rest of the API is unaffected.

### 4. Sharing

- [x] `POST /workspaces/{id}/share` → generates/rotates an unguessable `share_token`; `DELETE` revokes. Rotation invalidates the previous link.
- [x] Public read endpoint `GET /api/v1/shared/{share_token}` returns the workspace snapshot (no auth) — metadata + specs only; a download URL for uploaded rows is minted (5-minute TTL) only when the owner enabled "share includes data".
- [x] Duplicate-shared-workspace endpoint for signed-in visitors ("fork"). The copy is metadata-only — uploaded files aren't duplicated, so a fork never charges the visitor's quota — and chart→query references are remapped to the copied rows.
- [x] Activity log entries for share/unshare/view/fork events.

### 5. Authorization layer

- [x] Central permission service: `can(action, workspace, user)` / `require(...)` — owner, editor, viewer, share-token-bearer, anonymous. Matrix documented in the module docstring of [permissions.py](../../apps/api/src/app/services/permissions.py).
- [x] Every workspace router goes through `require()`. A caller with no read access gets **404, not 403**, so they can't learn the workspace exists; a caller who can read but not act gets an honest 403.
- [x] Permission matrix tested exhaustively — every (role × action) cell in [test_permissions.py](../../apps/api/tests/test_permissions.py).

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Save model | Snapshot-first (whole-document upsert) + granular CRUD | Matches local-first frontend; one atomic save, simple conflict story |
| Specs as JSONB | Validate envelope, store opaque | Frontend iterates on chart/layout formats without backend migrations |
| File uploads | Presigned direct-to-S3 | API never proxies gigabytes; scales trivially |
| Sharing | Capability URLs (token), not ACL UI | Ships the 90% use case with minimal surface |

## Deliverables & Acceptance Criteria

1. [x] Round trip proven by integration test: snapshot save → fetch on "another device" (new session) → identical workspace document.
2. [x] Conflict path tested: two sessions save divergent snapshots → second gets 409 + server version.
3. [x] Upload flow tested end-to-end, quota enforced, checksum mismatch rejected (and the object deleted). *(Against a fake S3 client, not a live MinIO — the API's own logic is what's under test; a smoke run against the compose MinIO is still worth doing before launch.)*
4. [x] Share link returns a read-only snapshot without auth; revocation makes it 404 immediately; fork creates an owned copy.
5. [x] Permission matrix test suite: every (role × action) combination asserted.
6. [x] p95 < 150 ms for snapshot GET of a workspace with 50 queries + 20 charts — **measured: p95 ≈ 12 ms against PostgreSQL 16**, via [test_performance.py](../../apps/api/tests/test_performance.py) (`pytest -m perf`). Save path measured too (p95 ≈ 17 ms).

Status: 182 tests pass **on both SQLite and PostgreSQL**, `ruff` clean, `alembic upgrade head` + `alembic check` clean.

## Bugs found after the fact

Two defects shipped in this phase and were caught later, both by running the
suite against PostgreSQL for the first time. Recorded because the *class* of
mistake matters more than the instances:

1. **Snapshot save INSERTed charts before the queries they reference.**
   `Chart.query_id` is a bare FK column with no `relationship()`, so
   SQLAlchemy's unit of work had no idea charts depended on queries and emitted
   the inserts in mapper order. SQLite with foreign keys off accepted it;
   PostgreSQL rejected *every* save containing a chart. `fork` had the identical
   bug. Fixed with explicit flushes; the test database now runs with
   `PRAGMA foreign_keys=ON` so SQLite is as strict as production.
2. **A client-supplied id already used by another workspace returned 500.**
   Child ids are client-generated UUIDs and globally unique keys, so a
   collision is ordinary bad input; it now returns 409 `id_conflict`.

## Estimated Effort

~3 weeks for one developer.

## Out of Scope (later phases)

Editor-role collaboration UI, background jobs/purge execution, server-side query compute (Phase 3), organizations/teams (post-launch).
