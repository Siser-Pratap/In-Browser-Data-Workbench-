/**
 * Friendly names for the generated schema types.
 *
 * `schema.ts` is written by `pnpm gen:api` straight from the API's OpenAPI
 * document and must never be hand-edited — which also makes
 * `components['schemas']['WorkspaceResponse']` the only honest way to name a
 * type. This module is the one place that indirection is spelled out, so the
 * rest of the app imports `Workspace` and the generated file stays disposable.
 *
 * Adding an alias here is free. Editing `schema.ts` is a merge conflict waiting
 * to happen the next time anyone regenerates.
 */

import type { components } from './schema';

type Schemas = components['schemas'];

// -- accounts ---------------------------------------------------------------
export type User = Schemas['UserResponse'];
export type TokenResponse = Schemas['TokenResponse'];
export type SignupRequest = Schemas['SignupRequest'];
export type LoginRequest = Schemas['LoginRequest'];
export type UpdateUserRequest = Schemas['UpdateUserRequest'];
export type UsageResponse = Schemas['UsageResponse'];

// -- workspaces -------------------------------------------------------------
export type Workspace = Schemas['WorkspaceResponse'];
export type WorkspaceList = Schemas['WorkspaceListResponse'];
export type WorkspaceCreate = Schemas['WorkspaceCreate'];
export type WorkspaceUpdate = Schemas['WorkspaceUpdate'];
export type SnapshotIn = Schemas['SnapshotIn'];
export type SnapshotResponse = Schemas['SnapshotResponse'];
export type ShareRequest = Schemas['ShareRequest'];
export type ShareResponse = Schemas['ShareResponse'];
export type DatasetIn = Schemas['DatasetIn'];
export type QueryIn = Schemas['QueryIn'];
export type ChartIn = Schemas['ChartIn'];
export type DashboardIn = Schemas['DashboardIn'];
export type DatasetResponse = Schemas['DatasetResponse'];
export type QueryResponse = Schemas['QueryResponse'];
export type ChartResponse = Schemas['ChartResponse'];
export type DashboardResponse = Schemas['DashboardResponse'];

// -- AI ---------------------------------------------------------------------
export type TableSchemaPayload = Schemas['TableSchema'];
export type ColumnSchemaPayload = Schemas['ColumnSchema'];
export type SqlGenerateRequest = Schemas['SqlGenerateRequest'];
export type SqlFixRequest = Schemas['SqlFixRequest'];
export type SqlExplainRequest = Schemas['SqlExplainRequest'];
export type InsightsRequest = Schemas['InsightsRequest'];
export type TableProfile = Schemas['TableProfile'];
export type ColumnProfile = Schemas['ColumnProfile'];
export type ChatCreateRequest = Schemas['ChatCreateRequest'];
export type ChatCreateResponse = Schemas['ChatCreateResponse'];
export type ChatMessageRequest = Schemas['ChatMessageRequest'];
export type ChatToolResultRequest = Schemas['ChatToolResultRequest'];
export type ClientToolResult = Schemas['ClientToolResult'];
