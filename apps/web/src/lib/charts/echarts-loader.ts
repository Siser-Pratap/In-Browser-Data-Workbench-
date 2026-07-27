/**
 * Lazily load ECharts, registering only the pieces this app draws with.
 *
 * ECharts' default entry pulls in every chart type, map support and the whole
 * component set. Registering explicitly through `echarts/core` keeps the lazy
 * chunk to the six forms the chart builder offers. As with Monaco, the import
 * is dynamic and memoized: someone who never opens a chart never downloads it.
 *
 * Both renderers are registered. Canvas draws on screen — it's what keeps a
 * 10k-point scatter interactive — while SVG backs the vector export, which has
 * to be produced by a second, headless instance.
 */

import type * as echartsCore from 'echarts/core';

export type ECharts = typeof echartsCore;

let loading: Promise<ECharts> | null = null;

export function loadECharts(): Promise<ECharts> {
  loading ??= (async () => {
    const [core, charts, components, renderers] = await Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ]);

    core.use([
      charts.BarChart,
      charts.LineChart,
      charts.ScatterChart,
      charts.PieChart,
      components.GridComponent,
      components.TooltipComponent,
      components.LegendComponent,
      components.TitleComponent,
      // Needed for the crosshair on line and area charts.
      components.AxisPointerComponent,
      renderers.CanvasRenderer,
      renderers.SVGRenderer,
    ]);

    return core;
  })();
  return loading;
}
