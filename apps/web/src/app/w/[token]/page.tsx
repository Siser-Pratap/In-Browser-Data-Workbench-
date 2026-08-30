'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { apiConfigured } from '@/lib/api/config';
import { ApiError } from '@/lib/api/problem';
import { fromSnapshot, type LocalWorkspace } from '@/lib/api/snapshot';
import { forkShared, getShared } from '@/lib/api/workspaces';
import { useAuthStore } from '@/stores/auth';
import { useDashboardStore } from '@/stores/dashboards';
import { useHistoryStore } from '@/stores/history';
import { useTabsStore } from '@/stores/tabs';

/**
 * A shared workspace, read-only.
 *
 * This page shows *what someone built*, not their data — the snapshot carries
 * queries, chart specs and dataset metadata and nothing else. So rather than
 * pretending to render a live dashboard over tables this browser doesn't have,
 * it lists the work honestly and offers the two things a visitor can actually
 * do with it: copy it into their own workbench, or fork it into their account.
 *
 * The read is anonymous by design: a share link is a capability, and it should
 * behave identically whether or not the visitor happens to have an account.
 */
export default function SharedWorkspacePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  // Whether an API exists is a build-time constant, so it decides the *initial*
  // state rather than being discovered by an effect that immediately setStates.
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; name: string; local: LocalWorkspace }
  >(() =>
    apiConfigured()
      ? { kind: 'loading' }
      : { kind: 'error', message: 'This build has no API configured, so links can’t be opened.' },
  );

  const signedIn = useAuthStore((state) => state.status) === 'authenticated';
  const restore = useAuthStore((state) => state.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (!apiConfigured()) return;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await getShared(token);
        if (cancelled) return;
        setState({
          kind: 'ready',
          name: snapshot.workspace?.name ?? 'Shared workspace',
          local: fromSnapshot(snapshot),
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message:
            error instanceof ApiError && error.status === 404
              ? 'This link is no longer valid — it may have been revoked.'
              : error instanceof Error
                ? error.message
                : 'Could not open this link.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <Centered>
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm">Opening shared workspace…</span>
      </Centered>
    );
  }

  if (state.kind === 'error') {
    return (
      <Centered>
        <p className="text-sm text-[var(--color-danger)]">{state.message}</p>
        <Link href="/" className="text-xs underline">
          Go to the workbench
        </Link>
      </Centered>
    );
  }

  const { local, name } = state;

  return (
    <div className="mx-auto min-h-full w-full max-w-3xl p-6">
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        <ArrowLeft className="size-3" /> Workbench
      </Link>

      <h1 className="text-lg font-semibold">{name}</h1>
      <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
        Shared, read-only. This page contains the queries and charts that were built — never the
        underlying rows.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={<Copy className="size-3.5" />}
          onClick={() => void copyIntoWorkbench(local)}
        >
          Copy into my workbench
        </Button>
        {signedIn && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void forkShared(token)
                .then((workspace) => toast.success(`Forked as “${workspace.name}”`))
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : 'Could not fork'),
                );
            }}
          >
            Fork to my account
          </Button>
        )}
      </div>

      <Section title={`Datasets (${local.datasets.length})`}>
        {local.datasets.length === 0 ? (
          <Empty>No datasets described.</Empty>
        ) : (
          <ul className="space-y-1 font-mono text-xs">
            {local.datasets.map((dataset) => (
              <li key={dataset.table} className="flex justify-between gap-3">
                <span>{dataset.table}</span>
                <span className="text-[var(--color-ink-muted)]">
                  {dataset.columns.length} cols · {dataset.sourceFilename || 'unknown source'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Queries (${local.queries.length})`}>
        {local.queries.length === 0 ? (
          <Empty>No saved queries.</Empty>
        ) : (
          <ul className="space-y-2">
            {local.queries.map((query) => (
              <li key={query.id}>
                <p className="text-xs font-medium">{query.name}</p>
                <pre className="mt-1 overflow-x-auto rounded bg-[var(--color-canvas)] p-2 font-mono text-[11px]">
                  {query.sql}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Dashboards (${local.dashboards.length})`}>
        {local.dashboards.length === 0 ? (
          <Empty>No dashboards.</Empty>
        ) : (
          <ul className="space-y-1 text-xs">
            {local.dashboards.map((dashboard) => (
              <li key={dashboard.id}>
                {dashboard.name}{' '}
                <span className="text-[var(--color-ink-muted)]">
                  ({dashboard.items.length} tile{dashboard.items.length === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * Merge the shared work into the visitor's own local workbench.
 *
 * Additive rather than destructive: tabs and dashboards are appended, never
 * replaced. Someone following a link is exploring, and losing their own open
 * work to a click would be indefensible.
 */
async function copyIntoWorkbench(local: LocalWorkspace): Promise<void> {
  const tabs = useTabsStore.getState();
  for (const query of local.queries) {
    const id = tabs.openTab({ name: query.name, sql: query.sql });
    if (query.chart) useTabsStore.getState().setChart(id, query.chart);
  }

  const dashboards = useDashboardStore.getState();
  await dashboards.replaceAll([...dashboards.dashboards, ...local.dashboards]);

  const history = useHistoryStore.getState();
  const existing = new Set(history.snippets.map((snippet) => snippet.name));
  for (const snippet of local.snippets) {
    if (!existing.has(snippet.name)) await history.addSnippet(snippet.name, snippet.sql);
  }

  toast.success('Copied into your workbench', {
    description: 'Load the matching data files to run the queries.',
  });
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase text-[var(--color-ink-muted)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[var(--color-ink-muted)]">{children}</p>;
}
