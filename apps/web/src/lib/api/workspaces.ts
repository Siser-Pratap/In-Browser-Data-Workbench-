/**
 * Workspace endpoints, including the snapshot sync used by cloud save.
 *
 * The snapshot pair is the important bit. `GET` returns an `ETag`; passing it
 * back as `If-Match` on `PUT` is what turns "last write wins" into "last write
 * wins *unless someone else wrote in between*", which the server answers with a
 * 409 so the UI can prompt instead of silently discarding the other session's
 * work. The ETag therefore has to survive the round trip, which is why these
 * two functions read the response headers rather than just the body.
 */

import { request, requestWithResponse } from './client';
import type {
  ShareResponse,
  SnapshotIn,
  SnapshotResponse,
  Workspace,
  WorkspaceList,
  WorkspaceUpdate,
} from './types';

export async function listWorkspaces(): Promise<WorkspaceList> {
  return request<WorkspaceList>('/workspaces');
}

export async function createWorkspace(name: string, description?: string): Promise<Workspace> {
  return request<Workspace>('/workspaces', {
    method: 'POST',
    body: { name, ...(description ? { description } : {}) },
  });
}

export async function updateWorkspace(id: string, body: WorkspaceUpdate): Promise<Workspace> {
  return request<Workspace>(`/workspaces/${id}`, { method: 'PATCH', body });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await request<void>(`/workspaces/${id}`, { method: 'DELETE' });
}

export interface SnapshotWithVersion {
  snapshot: SnapshotResponse;
  /** The `ETag`, to be replayed as `If-Match` on the next save. */
  etag: string | null;
}

export async function getSnapshot(workspaceId: string): Promise<SnapshotWithVersion> {
  const { data, response } = await requestWithResponse<SnapshotResponse>(
    `/workspaces/${workspaceId}/snapshot`,
  );
  return { snapshot: data, etag: response.headers.get('ETag') };
}

/**
 * Upsert the whole workspace document.
 *
 * Throws `ApiError` with `isConflict` when `etag` no longer matches the
 * server's version — the caller decides whether to overwrite or reload.
 */
export async function saveSnapshot(
  workspaceId: string,
  body: SnapshotIn,
  etag: string | null,
): Promise<SnapshotWithVersion> {
  const { data, response } = await requestWithResponse<SnapshotResponse>(
    `/workspaces/${workspaceId}/snapshot`,
    {
      method: 'PUT',
      body,
      headers: etag ? { 'If-Match': etag } : {},
    },
  );
  return { snapshot: data, etag: response.headers.get('ETag') };
}

// -- sharing ----------------------------------------------------------------

export async function shareWorkspace(id: string, includeData: boolean): Promise<ShareResponse> {
  return request<ShareResponse>(`/workspaces/${id}/share`, {
    method: 'POST',
    body: { include_data: includeData },
  });
}

export async function unshareWorkspace(id: string): Promise<void> {
  await request<void>(`/workspaces/${id}/share`, { method: 'DELETE' });
}

/**
 * Read a shared workspace by token.
 *
 * Sent `anonymous` so a signed-in visitor opening someone else's link gets the
 * share-token view rather than an implicit-membership one — the link should
 * behave the same for everyone holding it.
 */
export async function getShared(shareToken: string): Promise<SnapshotResponse> {
  return request<SnapshotResponse>(`/shared/${shareToken}`, { anonymous: true });
}

/** Copy a shared workspace into the caller's account. Requires sign-in. */
export async function forkShared(shareToken: string): Promise<Workspace> {
  return request<Workspace>(`/shared/${shareToken}/fork`, { method: 'POST' });
}
