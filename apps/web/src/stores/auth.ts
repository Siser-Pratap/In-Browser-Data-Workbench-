'use client';

import { create } from 'zustand';

import { currentUser, login, logout, signup } from '@/lib/api/auth';
import { onSessionLost, refreshSession, setAccessToken } from '@/lib/api/client';
import { apiConfigured } from '@/lib/api/config';
import type { User } from '@/lib/api/types';

/**
 * Who is signed in, if anyone.
 *
 * Nothing here is persisted, and that is the design rather than an omission.
 * The access token lives in memory in `api/client.ts`; the refresh token is an
 * httpOnly cookie. So "am I signed in?" is a question only the server can
 * answer, and `restore()` asks it once on boot. The cost is one request; the
 * benefit is that no credential is readable by script, and there is no stale
 * `localStorage` user to render before the server disagrees.
 *
 * `status` starts at `unknown` precisely so the UI can avoid flashing a
 * "Sign in" button at someone who already is.
 */

export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  busy: boolean;

  restore: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()((set) => ({
  // With no API configured the app is the anonymous workbench and never asks.
  status: apiConfigured() ? 'unknown' : 'anonymous',
  user: null,
  busy: false,

  restore: async () => {
    if (!apiConfigured()) {
      set({ status: 'anonymous', user: null });
      return;
    }
    const ok = await refreshSession();
    if (!ok) {
      set({ status: 'anonymous', user: null });
      return;
    }
    try {
      const user = await currentUser();
      set({ status: 'authenticated', user });
    } catch {
      // A refresh that works but a `/users/me` that doesn't means the account
      // is gone or deactivated; treat it as signed out rather than half-in.
      setAccessToken(null);
      set({ status: 'anonymous', user: null });
    }
  },

  signIn: async (email, password) => {
    set({ busy: true });
    try {
      await login(email, password);
      const user = await currentUser();
      set({ status: 'authenticated', user });
    } finally {
      set({ busy: false });
    }
  },

  signUp: async (email, password) => {
    set({ busy: true });
    try {
      // Signup does not sign you in — the server issues no tokens until the
      // credentials are presented to /login, so the caller decides what to do
      // with an account that may still need email verification.
      return await signup(email, password);
    } finally {
      set({ busy: false });
    }
  },

  signOut: async () => {
    set({ busy: true });
    try {
      await logout();
    } finally {
      set({ status: 'anonymous', user: null, busy: false });
    }
  },
}));

/**
 * Reflect a server-side session loss in the store.
 *
 * Registered at module scope so it is active regardless of which component
 * mounts first — a 401 that survives a refresh must not leave the UI showing a
 * signed-in header over requests that are all failing.
 */
onSessionLost(() => {
  useAuthStore.setState({ status: 'anonymous', user: null });
});
