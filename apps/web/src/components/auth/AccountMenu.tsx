'use client';

import { useEffect, useState } from 'react';
import { LogIn, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { AuthDialog } from '@/components/auth/AuthDialog';
import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { apiConfigured } from '@/lib/api/config';
import { useAuthStore } from '@/stores/auth';
import { useCloudStore } from '@/stores/cloud';

/**
 * The account entry point, and the only thing that starts a session.
 *
 * Renders nothing at all when no API is configured. That's the local-first
 * contract holding: a build with `NEXT_PUBLIC_API_URL` unset is byte-for-byte
 * the anonymous workbench, with no dead "Sign in" button implying a feature
 * that isn't there.
 */
export function AccountMenu() {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const restore = useAuthStore((state) => state.restore);
  const signOut = useAuthStore((state) => state.signOut);
  const refreshWorkspaces = useCloudStore((state) => state.refresh);
  const resetCloud = useCloudStore((state) => state.reset);
  const [dialogOpen, setDialogOpen] = useState(false);

  // One session probe on mount. `restore` is a no-op without an API.
  useEffect(() => {
    void restore();
  }, [restore]);

  // Load the workspace list once a session exists, so the switcher is populated
  // before the user opens it rather than after.
  useEffect(() => {
    if (status === 'authenticated') void refreshWorkspaces().catch(() => undefined);
  }, [status, refreshWorkspaces]);

  if (!apiConfigured()) return null;

  if (status !== 'authenticated') {
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          icon={<LogIn className="size-3.5" />}
          onClick={() => setDialogOpen(true)}
          // `unknown` means the session probe is still in flight; disabling
          // avoids offering sign-in to someone who turns out to be signed in.
          disabled={status === 'unknown'}
        >
          Sign in
        </Button>
        {dialogOpen && <AuthDialog onClose={() => setDialogOpen(false)} />}
      </>
    );
  }

  return (
    <Menu
      align="right"
      title={user?.email ?? 'Account'}
      label={
        <span className="flex max-w-[10rem] items-center gap-1 truncate">
          <UserRound className="size-3" />
          <span className="truncate">{user?.email ?? 'Account'}</span>
        </span>
      }
      items={[
        {
          label: 'Sign out',
          onSelect: () => {
            void (async () => {
              await signOut();
              // Cloud state is per-session; local work is untouched and stays.
              resetCloud();
              toast.success('Signed out. Your local workspace is still here.');
            })();
          },
        },
      ]}
    />
  );
}
