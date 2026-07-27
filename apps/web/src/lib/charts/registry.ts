import type { ECharts as EChartsInstance } from 'echarts/core';

/**
 * The live chart instances, by spec id.
 *
 * Exporting a dashboard to PDF means rasterising every chart on it, and the
 * export button is nowhere near the charts in the component tree. Registering
 * instances here — the same shape as the editor bridge — avoids threading refs
 * through the grid layout for a capability only the export path uses.
 *
 * Entries are removed on unmount, so a stale id can't hand back a disposed
 * instance.
 */
const instances = new Map<string, EChartsInstance>();

export function registerChart(id: string, instance: EChartsInstance): void {
  instances.set(id, instance);
}

export function unregisterChart(id: string): void {
  instances.delete(id);
}

export function getChart(id: string): EChartsInstance | null {
  const instance = instances.get(id);
  return instance && !instance.isDisposed() ? instance : null;
}
