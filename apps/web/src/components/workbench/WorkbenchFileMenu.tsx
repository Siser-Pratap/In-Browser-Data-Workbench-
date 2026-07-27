'use client';

import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { MIME_TYPES, downloadText, safeFilename } from '@/lib/export/download';
import {
  buildWorkbenchFile,
  missingDatasets,
  parseWorkbenchFile,
  type WorkbenchFile,
} from '@/lib/export/workbench';
import { track } from '@/lib/telemetry/telemetry';
import { useDashboardStore } from '@/stores/dashboards';
import { useDatasetStore } from '@/stores/datasets';
import { useHistoryStore } from '@/stores/history';
import { useTabsStore } from '@/stores/tabs';

/**
 * Export and import the whole workspace as a `.dwb.json`.
 *
 * The file carries queries, snippets, chart specs and dashboards but no rows —
 * so importing one restores the *work* and then says plainly which data files
 * still need dropping in. Being explicit about that is better than restoring
 * silently and leaving the user with a dashboard of broken tiles.
 */
export function WorkbenchFileMenu() {
  const datasets = useDatasetStore((state) => state.datasets);
  const tabs = useTabsStore((state) => state.tabs);
  const snippets = useHistoryStore((state) => state.snippets);
  const dashboards = useDashboardStore((state) => state.dashboards);
  const replaceDashboards = useDashboardStore((state) => state.replaceAll);
  const addSnippet = useHistoryStore((state) => state.addSnippet);
  const openTab = useTabsStore((state) => state.openTab);

  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<WorkbenchFile | null>(null);

  function exportFile() {
    const file = buildWorkbenchFile({
      datasets: datasets.map((dataset) => ({
        table: dataset.table,
        sourceFilename: dataset.sourceFilename,
        format: dataset.format,
        columns: dataset.columns,
        rowCount: dataset.rowCount,
      })),
      queries: tabs,
      snippets,
      dashboards,
    });
    downloadText(
      JSON.stringify(file, null, 2),
      `workbench-${safeFilename(new Date().toISOString().slice(0, 10))}.dwb.json`,
      MIME_TYPES['json']!,
    );
    track('workspace.export');
    toast.success('Workspace exported');
  }

  async function apply(file: WorkbenchFile) {
    for (const query of file.queries) {
      openTab({ name: query.name, sql: query.sql });
      if (query.chart) {
        const id = useTabsStore.getState().activeId;
        if (id) useTabsStore.getState().setChart(id, query.chart);
      }
    }
    const existing = new Set(snippets.map((snippet) => snippet.name));
    for (const snippet of file.snippets) {
      if (!existing.has(snippet.name)) await addSnippet(snippet.name, snippet.sql);
    }
    await replaceDashboards(file.dashboards);

    track('workspace.import');
    setPending(null);
    toast.success('Workspace imported');
  }

  return (
    <>
      <Menu
        align="right"
        title="Export or import the whole workspace"
        label={
          <span className="flex items-center gap-1">
            <FolderOpen className="size-3" /> Workspace
          </span>
        }
        items={[
          {
            label: 'Export workbench file…',
            detail: '.dwb.json',
            onSelect: exportFile,
          },
          {
            label: 'Import workbench file…',
            onSelect: () => picker.current?.click(),
          },
        ]}
      />

      <input
        ref={picker}
        type="file"
        accept=".json,.dwb.json,application/json"
        className="hidden"
        data-testid="workbench-file-picker"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          try {
            setPending(parseWorkbenchFile(await file.text()));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not read that file');
          }
        }}
      />

      {pending && (
        <ImportPreview
          file={pending}
          loadedTables={datasets.map((dataset) => dataset.table)}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply(pending)}
        />
      )}
    </>
  );
}

function ImportPreview({
  file,
  loadedTables,
  onCancel,
  onConfirm,
}: {
  file: WorkbenchFile;
  loadedTables: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const missing = missingDatasets(file, loadedTables);

  return (
    <Dialog
      title="Import workspace"
      description="Dashboards are replaced; queries and snippets are added alongside what you have."
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>
            Import
          </Button>
        </>
      }
    >
      <ul className="space-y-1 text-xs">
        <li>{file.queries.length} quer{file.queries.length === 1 ? 'y' : 'ies'}</li>
        <li>{file.snippets.length} snippet(s)</li>
        <li>{file.dashboards.length} dashboard(s)</li>
      </ul>

      {missing.length > 0 && (
        <div className="mt-3 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-2 text-xs">
          <p className="font-medium">
            These tables aren&rsquo;t loaded yet — drop the files in to make the charts work:
          </p>
          <ul className="mt-1 space-y-0.5 font-mono">
            {missing.map((dataset) => (
              <li key={dataset.table}>
                {dataset.table} — {dataset.sourceFilename}
              </li>
            ))}
          </ul>
          <p className="mt-2 font-sans">
            Workbench files never contain your data, so the files themselves have to travel
            separately.
          </p>
        </div>
      )}
    </Dialog>
  );
}
