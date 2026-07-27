'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useChartData } from '@/components/charts/useChartData';
import { Menu } from '@/components/ui/Menu';
import type { ChartSpec } from '@/lib/charts/spec';
import { chartToPngDataUrl, chartToSvg } from '@/lib/export/chart';
import { MIME_TYPES, downloadBlob, downloadText, safeFilename } from '@/lib/export/download';
import { useUiStore } from '@/stores/ui';

/** PNG and SVG export for a single chart. */
export function ChartExportMenu({ spec }: { spec: ChartSpec }) {
  const theme = useUiStore((state) => state.theme);
  const { result } = useChartData(spec);
  const [busy, setBusy] = useState(false);

  const filename = safeFilename(spec.options.title || spec.encoding.y || 'chart');
  const imageable = spec.type !== 'kpi' && spec.type !== 'table';

  async function exportPng() {
    const dataUrl = chartToPngDataUrl(spec.id, theme);
    if (!dataUrl) {
      toast.error('The chart is still rendering — try again in a moment.');
      return;
    }
    const blob = await (await fetch(dataUrl)).blob();
    downloadBlob(blob, `${filename}.png`);
  }

  async function exportSvg() {
    if (!result) {
      toast.error('The chart has no data to export yet.');
      return;
    }
    setBusy(true);
    try {
      downloadText(await chartToSvg(spec, result, theme), `${filename}.svg`, MIME_TYPES['svg']!);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'SVG export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Menu
      align="right"
      title="Export this chart"
      label={
        <span className="flex items-center gap-1">
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
          Chart
        </span>
      }
      items={[
        {
          label: 'PNG',
          detail: 'raster',
          disabled: !imageable || busy,
          onSelect: () => void exportPng(),
        },
        {
          label: 'SVG',
          detail: 'vector',
          disabled: !imageable || busy,
          onSelect: () => void exportSvg(),
        },
      ]}
    />
  );
}
