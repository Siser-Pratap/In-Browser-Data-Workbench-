'use client';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { setAnalystConsent } from '@/lib/ai/consent';
import { track } from '@/lib/telemetry/telemetry';

/**
 * The one moment this product asks to send data off the machine.
 *
 * Written to be understood rather than clicked past: it says what leaves, what
 * doesn't, and how to take it back. Nothing here is a dark pattern — "Not now"
 * is a real, equally-weighted option, because the workbench is entirely usable
 * without the analyst and the rest of the app keeps its promise either way.
 */
export function AnalystConsentDialog({
  onGranted,
  onClose,
}: {
  onGranted: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="The analyst needs to see your results"
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button
            variant="primary"
            onClick={() => {
              setAnalystConsent(true);
              track('ai.analyst.consent');
              onGranted();
            }}
          >
            Allow and continue
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <p>
          To answer a question the analyst writes SQL, runs it{' '}
          <span className="font-medium">in this browser</span>, and reads the results back to
          decide what to ask next. Those results are sent to the AI.
        </p>

        <div className="rounded border border-[var(--color-border)] p-2">
          <p className="font-medium">What is sent</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[var(--color-ink-muted)]">
            <li>Table and column names and types</li>
            <li>Aggregates: counts, sums, ranges, most common values</li>
            <li>
              Up to 50 rows of each query result —{' '}
              <span className="font-medium text-[var(--color-ink)]">actual values</span>
            </li>
          </ul>
        </div>

        <div className="rounded border border-[var(--color-border)] p-2">
          <p className="font-medium">What is never sent</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[var(--color-ink-muted)]">
            <li>Your files. They are never uploaded, with or without this.</li>
            <li>Whole tables — queries run here and only their results travel.</li>
          </ul>
        </div>

        <p className="text-[var(--color-ink-muted)]">
          The rest of the workbench is unaffected: importing, SQL, charts and dashboards stay
          entirely local. You can revoke this any time under Privacy.
        </p>
      </div>
    </Dialog>
  );
}
