'use client';

import { useState } from 'react';
import { BookmarkPlus, Play, Sparkles, Square, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import type { AskMode } from '@/components/ai/AskAiDialog';
import type { TransformKind } from '@/components/transform/TransformDialog';
import { LazyAskAiDialog, LazyTransformDialog } from '@/components/workbench/lazy';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { apiConfigured } from '@/lib/api/config';
import { useDatasetStore } from '@/stores/datasets';
import { useHistoryStore } from '@/stores/history';

interface Props {
  sql: string;
  running: boolean;
  onRun: () => void;
  onCancel: () => void;
  onFormat: () => void;
  onOpenInEditor: (sql: string) => void;
}

const TRANSFORMS: { kind: TransformKind; label: string }[] = [
  { kind: 'filter', label: 'Filter rows…' },
  { kind: 'derive', label: 'Add a derived column…' },
  { kind: 'aggregate', label: 'Group and summarise…' },
  { kind: 'join', label: 'Join two tables…' },
];

export function EditorToolbar({ sql, running, onRun, onCancel, onFormat, onOpenInEditor }: Props) {
  const activeTable = useDatasetStore((state) => state.activeTable);
  const datasets = useDatasetStore((state) => state.datasets);
  const addSnippet = useHistoryStore((state) => state.addSnippet);

  const [transform, setTransform] = useState<TransformKind | null>(null);
  const [savingSnippet, setSavingSnippet] = useState(false);
  const [ask, setAsk] = useState<AskMode | null>(null);

  const table = activeTable ?? datasets[0]?.table ?? null;
  // No API means no AI. The buttons aren't disabled, they're absent — a greyed
  // control implies a feature you could unlock, and in this build there isn't one.
  const aiAvailable = apiConfigured();

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
      {running ? (
        <Button
          variant="danger"
          size="sm"
          icon={<Square className="size-3" />}
          onClick={onCancel}
          title="Stop the running query"
        >
          Stop
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          icon={<Play className="size-3" />}
          onClick={onRun}
          disabled={!sql.trim()}
          title="Run (Cmd/Ctrl+Enter) — runs the selection if there is one"
        >
          Run
        </Button>
      )}

      <Button size="sm" onClick={onFormat} disabled={!sql.trim()} title="Format (Shift+Alt+F)">
        Format
      </Button>

      <Button
        size="sm"
        icon={<BookmarkPlus className="size-3" />}
        disabled={!sql.trim()}
        onClick={() => setSavingSnippet(true)}
        title="Save this query as a reusable snippet"
      >
        Snippet
      </Button>

      <Menu
        className="ml-1"
        label={
          <span className="flex items-center gap-1">
            <Wand2 className="size-3" /> Transform
          </span>
        }
        items={TRANSFORMS.map(({ kind, label }) => ({
          label,
          disabled: !table,
          onSelect: () => setTransform(kind),
        }))}
      />

      {aiAvailable && (
        <>
          <Button
            size="sm"
            icon={<Sparkles className="size-3" />}
            onClick={() => setAsk({ kind: 'ask' })}
            disabled={!table}
            title="Describe what you want in English and get SQL back"
          >
            Ask AI
          </Button>
          <Button
            size="sm"
            disabled={!sql.trim()}
            onClick={() => setAsk({ kind: 'explain', sql })}
            title="Explain this query in plain English"
          >
            Explain
          </Button>
        </>
      )}

      <span className="ml-auto pr-1 text-[11px] text-[var(--color-ink-muted)]">
        Cmd/Ctrl+Enter to run · select text to run just that
      </span>

      {transform && table && (
        <LazyTransformDialog
          kind={transform}
          table={table}
          onClose={() => setTransform(null)}
          onOpenInEditor={(generated) => {
            setTransform(null);
            onOpenInEditor(generated);
          }}
        />
      )}

      {ask && (
        <LazyAskAiDialog
          mode={ask}
          onClose={() => setAsk(null)}
          onUseSql={(generated) => onOpenInEditor(generated)}
        />
      )}

      {savingSnippet && (
        <SnippetDialog
          sql={sql}
          onClose={() => setSavingSnippet(false)}
          onSave={async (name) => {
            await addSnippet(name, sql);
            setSavingSnippet(false);
            toast.success(`Saved snippet “${name}”`);
          }}
        />
      )}
    </div>
  );
}

function SnippetDialog({
  sql,
  onClose,
  onSave,
}: {
  sql: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title="Save as snippet"
      description="Snippets appear in autocomplete and in the command palette."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(name.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        {({ id, className }) => (
          <input
            id={id}
            className={className}
            value={name}
            placeholder="Monthly revenue by region"
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <pre className="mt-3 max-h-40 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] whitespace-pre-wrap">
        {sql}
      </pre>
    </Dialog>
  );
}
