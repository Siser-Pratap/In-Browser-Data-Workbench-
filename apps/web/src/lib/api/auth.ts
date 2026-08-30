/**
 * Account endpoints.
 *
 * Thin on purpose — the interesting parts (token lifetime, refresh, session
 * loss) live in `client.ts` so every call gets them, not just these.
 */

import { request, setAccessToken } from './client';
import type { TokenResponse, UpdateUserRequest, User } from './types';

export async function signup(email: string, password: string): Promise<User> {
  return request<User>('/auth/signup', {
    method: 'POST',
    body: { email, password },
    noRetry: true,
  });
}

/**
 * Sign in and install the access token.
 *
 * The refresh token isn't in the response — it's set as an httpOnly cookie the
 * browser will replay on `/auth/refresh`. That's why nothing is stored here.
 */
export async function login(email: string, password: string): Promise<TokenResponse> {
  const tokens = await request<TokenResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
    noRetry: true,
  });
  setAccessToken(tokens.access_token);
  return tokens;
}

export async function logout(): Promise<void> {
  try {
    await request<unknown>('/auth/logout', { method: 'POST', noRetry: true });
  } finally {
    // Drop the local token even if the server call failed. Leaving a signed-out
    // user holding a token that still works for its remaining TTL is worse than
    // an orphaned refresh row the server will expire anyway.
    setAccessToken(null);
  }
}

export async function currentUser(): Promise<User> {
  return request<User>('/users/me');
}

export async function updateProfile(body: UpdateUserRequest): Promise<User> {
  return request<User>('/users/me', { method: 'PATCH', body });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await request<unknown>('/auth/password/forgot', {
    method: 'POST',
    body: { email },
    noRetry: true,
  });
}
