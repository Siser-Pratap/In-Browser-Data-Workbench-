/**
 * Exporting a chart as an image.
 *
 * PNG comes from the live canvas instance — it is already on screen, so
 * re-rendering it would only risk a different result. SVG cannot: an ECharts
 * instance is bound to one renderer for its lifetime and the on-screen one is
 * canvas (which is what keeps a 10k-point scatter interactive). So the vector
 * export builds a second, detached instance with the SVG renderer and reads its
 * markup out.
 */

import { buildOption } from '@/lib/charts/echarts';
import { loadECharts } from '@/lib/charts/echarts-loader';
import { getChart } from '@/lib/charts/registry';
import { chromeFor } from '@/lib/charts/theme';
import type { ChartSpec } from '@/lib/charts/spec';
import type { QueryResult } from '@/lib/engine/types';
import type { Theme } from '@/stores/ui';

/** Retina-ish, so a chart pasted into a document isn't soft. */
const PNG_PIXEL_RATIO = 2;
const OFFSCREEN = { width: 960, height: 540 };

export function chartToPngDataUrl(specId: string, theme: Theme): string | null {
  const chart = getChart(specId);
  if (!chart) return null;
  return chart.getDataURL({
    type: 'png',
    pixelRatio: PNG_PIXEL_RATIO,
    // The on-screen chart has a transparent background so it sits on the app's
    // surface; an exported file needs a real one or it reads as a black square
    // in half the viewers that open it.
    backgroundColor: chromeFor(theme).surface,
  });
}

export async function chartToSvg(
  spec: ChartSpec,
  result: QueryResult,
  theme: Theme,
): Promise<string> {
  const echarts = await loadECharts();
  const chrome = chromeFor(theme);

  // Detached but attached to the document: ECharts measures text, and a node
  // outside the document has no layout, which collapses every label to zero
  // width. Positioned off-screen instead of hidden, since `display: none` has
  // the same problem.
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-10000px;top:0;width:${OFFSCREEN.width}px;height:${OFFSCREEN.height}px;`;
  document.body.append(host);

  try {
    const chart = echarts.init(host, undefined, { renderer: 'svg', ...OFFSCREEN });
    const { option } = buildOption(spec, result, theme);
    chart.setOption({ ...option, backgroundColor: chrome.surface }, { notMerge: true });
    const svg = host.querySelector('svg')?.outerHTML ?? '';
    chart.dispose();
    return svg;
  } finally {
    host.remove();
  }
}

/** A data-URL's bytes, for embedding in a PDF. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
