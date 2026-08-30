'use client';

import { useState } from 'react';
import { Copy, Link2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import type { ShareResponse, Workspace } from '@/lib/api/types';
import { shareWorkspace, unshareWorkspace } from '@/lib/api/workspaces';
import { track } from '@/lib/telemetry/telemetry';

/**
 * Create or revoke a share link.
 *
 * The link is a capability — holding the URL is the authorization — so the copy
 * says so plainly rather than implying an access list that doesn't exist.
 *
 * "Include data" is off by default and stays a deliberate second action. It
 * only affects datasets the owner previously chose to upload; a workspace whose
 * tables live only in this browser has nothing to include either way, which is
 * why the option is explained rather than just offered.
 */
export function ShareDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [includeData, setIncludeData] = useState(false);
  const [busy, setBusy] = useState(false);

  // The share URL the API returns points at the API's own origin; the page that
  // renders a shared workspace is this app's /w/{token}. Rebuild it here rather
  // than teaching the backend about the frontend's routes.
  const url = share ? `${globalThis.location.origin}/w/${share.share_token}` : '';

  async function create() {
    setBusy(true);
    try {
      setShare(await shareWorkspace(workspace.id, includeData));
      track('workspace.share');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create a link');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await unshareWorkspace(workspace.id);
      setShare(null);
      toast.success('Link revoked');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Share “${workspace.name}”`}
      description="Anyone with the link can open a read-only copy."
      onClose={onClose}
      width="max-w-md"
      footer={
        share ? (
          <>
            <Button variant="danger" busy={busy} onClick={() => void revoke()}>
              Revoke link
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              icon={<Link2 className="size-3.5" />}
              onClick={() => void create()}
            >
              Create link
            </Button>
          </>
        )
      }
    >
      {share ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-xs"
              aria-label="Share link"
            />
            <Button
              icon={<Copy className="size-3.5" />}
              onClick={() => {
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast.success('Link copied'))
                  .catch(() => toast.error('Could not copy'));
              }}
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Anyone holding this link can read the workspace. Revoke it to cut access.
          </p>
        </div>
      ) : (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeData}
            onChange={(event) => setIncludeData(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Also share uploaded data files</span>
            <span className="mt-0.5 block text-[var(--color-ink-muted)]">
              Only applies to datasets you explicitly uploaded. Tables that exist only in your
              browser are never included — the recipient gets your queries, charts and dashboards
              and supplies their own files.
            </span>
          </span>
        </label>
      )}
    </Dialog>
  );
}
