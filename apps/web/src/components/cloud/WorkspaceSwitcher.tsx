'use client';

import { useState } from 'react';
import { Cloud, CloudUpload } from 'lucide-react';
import { toast } from 'sonner';

import { ShareDialog } from '@/components/cloud/ShareDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { ApiError } from '@/lib/api/problem';
import { useAuthStore } from '@/stores/auth';
import { useCloudStore } from '@/stores/cloud';

/**
 * Pick, create and save a cloud workspace.
 *
 * Saving is a button, never a background timer — see the note in
 * `stores/cloud.ts`. The label carries the last-saved time because the only
 * thing worse than an explicit save is an explicit save you can't tell worked.
 */
export function WorkspaceSwitcher() {
  const status = useAuthStore((state) => state.status);
  const workspaces = useCloudStore((state) => state.workspaces);
  const activeId = useCloudStore((state) => state.activeId);
  const cloudStatus = useCloudStore((state) => state.status);
  const lastSavedAt = useCloudStore((state) => state.lastSavedAt);
  const conflict = useCloudStore((state) => state.conflict);
  const open = useCloudStore((state) => state.open);
  const save = useCloudStore((state) => state.save);
  const create = useCloudStore((state) => state.create);

  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState(false);

  if (status !== 'authenticated') return null;

  const active = workspaces.find((workspace) => workspace.id === activeId) ?? null;

  const items: MenuItem[] = [
    ...workspaces.map((workspace) => ({
      label: workspace.name,
      detail: workspace.id === activeId ? 'open' : undefined,
      onSelect: () => {
        void open(workspace.id)
          .then(() => toast.success(`Opened ${workspace.name}`))
          .catch((error: unknown) => toast.error(message(error)));
      },
    })),
    { label: 'New workspace…', onSelect: () => setCreating(true) },
  ];

  if (active) {
    items.push({
      label: 'Share…',
      onSelect: () => setSharing(true),
    });
  }

  return (
    <>
      <Menu
        align="right"
        title="Cloud workspaces"
        label={
          <span className="flex max-w-[12rem] items-center gap-1 truncate">
            <Cloud className="size-3" />
            <span className="truncate">{active ? active.name : 'Cloud'}</span>
          </span>
        }
        items={items}
      />

      {active && (
        <Button
          size="sm"
          variant="ghost"
          icon={<CloudUpload className="size-3.5" />}
          busy={cloudStatus === 'saving'}
          title={lastSavedAt ? `Last saved ${new Date(lastSavedAt).toLocaleTimeString()}` : 'Save'}
          onClick={() => {
            void save()
              .then(() => toast.success('Saved to the cloud'))
              .catch((error: unknown) => {
                // A conflict opens the resolver below rather than a toast that
                // the user can dismiss without deciding anything.
                if (error instanceof ApiError && error.isConflict) return;
                toast.error(message(error));
              });
          }}
        >
          Save
        </Button>
      )}

      {creating && (
        <NewWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreate={async (name) => {
            const workspace = await create(name);
            setCreating(false);
            // Immediately push what's on screen, so a new workspace isn't an
            // empty shell until the user notices they must also press Save.
            await save().catch(() => undefined);
            toast.success(`Created ${workspace.name}`);
          }}
        />
      )}

      {sharing && active && <ShareDialog workspace={active} onClose={() => setSharing(false)} />}

      {conflict && <ConflictDialog />}
    </>
  );
}

function NewWorkspaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('My workspace');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title="New cloud workspace"
      description="Saves your queries, charts and dashboards. Never your data."
      onClose={onClose}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void onCreate(name.trim() || 'My workspace').finally(() => setBusy(false));
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <Field label="Name">
        {({ id, className }) => (
          <input
            id={id}
            className={className}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

/**
 * What to do when someone else saved first.
 *
 * Presented as a choice rather than resolved automatically because both answers
 * lose work — the only question is whose, and that isn't ours to decide.
 */
function ConflictDialog() {
  const resolve = useCloudStore((state) => state.resolveConflict);
  const busy = useCloudStore((state) => state.status) === 'saving';

  return (
    <Dialog
      title="This workspace changed elsewhere"
      description="Another session saved since you opened it."
      onClose={() => void resolve('reload')}
      width="max-w-md"
      footer={
        <>
          <Button busy={busy} onClick={() => void resolve('reload')}>
            Discard mine, load theirs
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              void resolve('overwrite')
                .then(() => toast.success('Saved over the other version'))
                .catch((error: unknown) => toast.error(message(error)));
            }}
          >
            Keep mine, overwrite
          </Button>
        </>
      }
    >
      <p className="text-xs text-[var(--color-ink-muted)]">
        Whichever you choose, the tables loaded in this browser are untouched — only the saved
        queries, charts and dashboards differ.
      </p>
    </Dialog>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
