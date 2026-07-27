'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { SAMPLE_DATASETS, SAMPLE_QUERY, fetchSample } from '@/lib/files/samples';
import { track } from '@/lib/telemetry/telemetry';
import { useCatalogStore } from '@/stores/catalog';
import { useDatasetStore } from '@/stores/datasets';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';

/**
 * "Try it with sample data."
 *
 * Loads both bundled tables and opens a starter query alongside them, rather
 * than dropping the user into an empty editor with two tables they know nothing
 * about. Skips the import dialog on purpose: the whole point is to be one click
 * from something worth looking at.
 */
export function SampleDataButton({ compact = false }: { compact?: boolean }) {
  const importFile = useDatasetStore((state) => state.importFile);
  const refreshCatalog = useCatalogStore((state) => state.refresh);
  const openTab = useTabsStore((state) => state.openTab);
  const setView = useUiStore((state) => state.setView);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      for (const sample of SAMPLE_DATASETS) {
        await importFile(await fetchSample(sample), sample.options);
      }
      await refreshCatalog();
      track('file.import.sample');
      openTab({ name: 'Revenue by region', sql: SAMPLE_QUERY, run: true });
      setView('sql');
      toast.success('Loaded the sample data', {
        description: 'Two tables and a starter query — everything still local to this browser.',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load the sample data');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={compact ? 'ghost' : 'outline'}
      size={compact ? 'sm' : 'md'}
      busy={busy}
      icon={<Sparkles className="size-3.5" />}
      onClick={() => void load()}
    >
      {busy ? 'Loading sample data…' : 'Try it with sample data'}
    </Button>
  );
}
