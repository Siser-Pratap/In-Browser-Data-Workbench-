'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { requestPasswordReset } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/problem';
import { track } from '@/lib/telemetry/telemetry';
import { useAuthStore } from '@/stores/auth';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

const TITLES: Record<Mode, string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create an account',
  forgot: 'Reset your password',
};

/**
 * Sign in, sign up, and start a password reset.
 *
 * One dialog with a mode rather than three routes: signing in is never the
 * reason someone opened this app, so it should interrupt as little as possible
 * and hand the workbench straight back. The copy leads with what an account
 * does *not* change — the local-first promise — because that's the question a
 * privacy-motivated user actually has when a sign-in box appears.
 */
export function AuthDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = useAuthStore((state) => state.busy);
  const signIn = useAuthStore((state) => state.signIn);
  const signUp = useAuthStore((state) => state.signUp);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email);
        // Deliberately the same message whether or not the address exists —
        // anything else turns this form into an account-enumeration oracle.
        toast.success('If that address has an account, a reset link is on its way.');
        onClose();
        return;
      }

      if (mode === 'sign-up') {
        await signUp(email, password);
        track('account.sign_up');
        // Signup issues no tokens, so sign in with the same credentials rather
        // than making the user retype them.
        await signIn(email, password);
      } else {
        await signIn(email, password);
      }
      track('account.sign_in');
      toast.success(mode === 'sign-up' ? 'Account created' : 'Signed in');
      onClose();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Something went wrong.',
      );
    }
  }

  return (
    <Dialog
      title={TITLES[mode]}
      description="Your data stays in this browser either way — an account saves queries, charts and dashboards, never rows."
      onClose={onClose}
      width="max-w-sm"
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-3">
        <Field label="Email">
          {({ id, className }) => (
            <input
              id={id}
              className={className}
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>

        {mode !== 'forgot' && (
          <Field
            label="Password"
            hint={mode === 'sign-up' ? 'At least 8 characters.' : undefined}
          >
            {({ id, className }) => (
              <input
                id={id}
                className={className}
                type="password"
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'sign-up' ? 8 : 1}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
        )}

        {error && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" busy={busy} className="w-full">
          {mode === 'sign-up' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}
        </Button>

        <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
          <button
            type="button"
            className="underline hover:text-[var(--color-ink)]"
            onClick={() => {
              setError(null);
              setMode(mode === 'sign-up' ? 'sign-in' : 'sign-up');
            }}
          >
            {mode === 'sign-up' ? 'I already have an account' : 'Create an account'}
          </button>
          {mode !== 'forgot' && (
            <button
              type="button"
              className="underline hover:text-[var(--color-ink)]"
              onClick={() => {
                setError(null);
                setMode('forgot');
              }}
            >
              Forgot password?
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
