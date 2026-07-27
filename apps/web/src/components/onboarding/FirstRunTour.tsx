'use client';

import { useState, useSyncExternalStore } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SampleDataButton } from '@/components/onboarding/SampleDataButton';
import { useUiStore } from '@/stores/ui';

const STEPS = [
  {
    title: 'Your data never leaves this browser',
    body: (
      <>
        <p>
          Files you drop in are read by a SQL engine compiled to WebAssembly, running inside this
          tab. There is no upload, no account, and no server to send anything to — which is also
          why it works with the network off.
        </p>
        <p className="mt-2">
          A copy is kept in this browser&rsquo;s private storage so a reload doesn&rsquo;t lose
          your work. “Clear workspace” in the top bar deletes it.
        </p>
      </>
    ),
  },
  {
    title: 'Query it, or point and click',
    body: (
      <>
        <p>
          The <strong>SQL</strong> view has a full editor with autocomplete over your own
          columns. <kbd className="rounded border border-[var(--color-border)] px-1">⌘/Ctrl</kbd> +{' '}
          <kbd className="rounded border border-[var(--color-border)] px-1">Enter</kbd> runs it;
          selecting part of the query runs only that.
        </p>
        <p className="mt-2">
          Don&rsquo;t write SQL? The <strong>Transform</strong> menu builds filters, derived
          columns, group-bys and joins — and shows you the SQL it generated, so you can read it,
          edit it, and learn it.
        </p>
      </>
    ),
  },
  {
    title: 'Chart it, then arrange it',
    body: (
      <>
        <p>
          Every result has a <strong>Chart</strong> tab beside it that guesses a sensible chart
          from your column types. Charts group and sample inside the engine, so they stay fast on
          tables far too big to hold in a page.
        </p>
        <p className="mt-2">
          “Add to” puts a chart on a dashboard, where you can arrange, filter and export it as
          PDF or a standalone HTML file.
        </p>
      </>
    ),
  },
];

/**
 * The first-run tour.
 *
 * Three panels, skippable at every step, shown once. It leads with the privacy
 * model rather than with features because that's the claim people are most
 * likely to disbelieve — and it's the reason to choose this over a hosted tool.
 */
export function FirstRunTour() {
  const seen = useUiStore((state) => state.tourSeen);
  const dismiss = useUiStore((state) => state.dismissTour);
  const [step, setStep] = useState(0);

  // `tourSeen` defaults to false so a genuinely first visit shows the tour, but
  // that default is also what the server renders and what a returning visitor
  // sees for the instant before localStorage is read. Gating on rehydration
  // keeps the dialog from flashing at someone who dismissed it months ago.
  const hydrated = useSyncExternalStore(
    (listener) => useUiStore.persist.onFinishHydration(listener),
    () => useUiStore.persist.hasHydrated(),
    () => false,
  );

  if (!hydrated || seen) return null;
  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;

  return (
    <Dialog
      title={current.title}
      onClose={dismiss}
      width="max-w-md"
      footer={
        <>
          <div className="mr-auto flex items-center gap-1.5" aria-hidden>
            {STEPS.map((_, index) => (
              <span
                key={index}
                className={
                  index === step
                    ? 'size-1.5 rounded-full bg-[var(--color-accent)]'
                    : 'size-1.5 rounded-full bg-[var(--color-border)]'
                }
              />
            ))}
          </div>
          <Button onClick={dismiss}>{last ? 'Close' : 'Skip'}</Button>
          {!last && (
            <Button
              variant="primary"
              icon={<ArrowRight className="size-3.5" />}
              onClick={() => setStep((value) => value + 1)}
            >
              Next
            </Button>
          )}
          {last && <SampleDataButton compact />}
        </>
      }
    >
      <div className="space-y-3 text-sm text-[var(--color-ink-muted)]">
        {step === 0 && (
          <ShieldCheck className="size-8 text-[var(--color-ok)]" aria-hidden />
        )}
        {current.body}
      </div>
    </Dialog>
  );
}
