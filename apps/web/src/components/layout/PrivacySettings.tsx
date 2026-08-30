'use client';

import { useSyncExternalStore } from 'react';
import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  getAnalystConsent,
  getAnalystConsentServerSnapshot,
  setAnalystConsent,
  subscribeAnalystConsent,
} from '@/lib/ai/consent';
import { apiConfigured } from '@/lib/api/config';
import {
  getTelemetrySnapshot,
  getTelemetryServerSnapshot,
  setTelemetryEnabled,
  subscribeTelemetry,
} from '@/lib/telemetry/telemetry';
import { formatCount } from '@/lib/utils/format';
import { useUiStore } from '@/stores/ui';

/**
 * Privacy and usage settings.
 *
 * The counts are shown, not just described. A privacy-first tool asking to
 * count feature usage should be able to put the entire record on screen — if it
 * couldn't, the claim that it holds nothing sensitive wouldn't be checkable.
 */
export function PrivacySettings({ onClose }: { onClose: () => void }) {
  // The counts live in localStorage, outside React — `useSyncExternalStore` is
  // how you read that without a mount effect racing the first paint.
  const telemetry = useSyncExternalStore(
    subscribeTelemetry,
    getTelemetrySnapshot,
    getTelemetryServerSnapshot,
  );
  const analystConsent = useSyncExternalStore(
    subscribeAnalystConsent,
    getAnalystConsent,
    getAnalystConsentServerSnapshot,
  );
  const replayTour = useUiStore((state) => state.replayTour);

  const entries = Object.entries(telemetry.counts).sort((a, b) => b[1] - a[1]);

  return (
    <Dialog
      title="Privacy"
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4 text-sm">
        {/* The unqualified "no network requests after load" claim only holds
            for a build with no API. Once there is one, sign-in and cloud save
            do talk to a server — so the honest sentence differs, and the part
            that never changes (your files are not uploaded) leads either way. */}
        <p className="flex items-start gap-2 rounded border border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 p-2 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />
          <span>
            Your files are read by a WebAssembly SQL engine inside this tab and are never
            uploaded.{' '}
            {apiConfigured()
              ? 'Importing, querying, charting and dashboards make no network requests at all. Signing in, saving to the cloud and the AI features do — and each says what it sends.'
              : 'The app makes no network requests after it loads — you can verify that in your browser’s network panel.'}
          </span>
        </p>

        {apiConfigured() && (
          <div>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={analystConsent}
                onChange={(event) => setAnalystConsent(event.target.checked)}
              />
              <span>
                <span className="font-medium">Let the AI analyst see my query results</span>
                <span className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">
                  The analyst answers questions by running SQL here and reading the results back,
                  so up to 50 rows per query — including actual values — are sent to the AI. Every
                  other AI feature sends only table and column names. Turning this off stops the
                  analyst; nothing else changes.
                </span>
              </span>
            </label>
          </div>
        )}

        <div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={telemetry.enabled}
              onChange={(event) => setTelemetryEnabled(event.target.checked)}
            />
            <span>
              <span className="font-medium">Count which features I use</span>
              <span className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">
                Counts only — how many times you ran a query or made a chart. Never a table name,
                a column, a query, or a value. Stored in this browser and not transmitted
                anywhere. Turning this off deletes the counts.
              </span>
            </span>
          </label>
        </div>

        {telemetry.enabled && (
          <div>
            <p className="mb-1 text-xs font-medium">Everything recorded so far</p>
            {entries.length === 0 ? (
              <p className="text-xs text-[var(--color-ink-muted)]">Nothing yet.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-xs">
                {entries.map(([event, count]) => (
                  <div key={event} className="contents">
                    <dt className="truncate text-[var(--color-ink-muted)]">{event}</dt>
                    <dd className="text-right">{formatCount(count)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            replayTour();
            onClose();
          }}
        >
          Show the intro again
        </Button>
      </div>
    </Dialog>
  );
}
