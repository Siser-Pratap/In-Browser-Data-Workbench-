/**
 * Dashboard exports: PDF and a standalone HTML file.
 *
 * Both are produced entirely in the browser from charts that are already
 * rendered — nothing is uploaded to a rendering service, which for a
 * privacy-first tool is the whole point.
 */

import { toCsv } from '@/lib/export/serialize';
import { chartToSvg } from '@/lib/export/chart';
import { chromeFor } from '@/lib/charts/theme';
import type { ChartSpec } from '@/lib/charts/spec';
import type { QueryResult } from '@/lib/engine/types';
import type { Dashboard } from '@/stores/dashboards';
import type { Theme } from '@/stores/ui';

export interface ChartSnapshot {
  spec: ChartSpec;
  /** The rows behind the chart, as rendered. */
  result: QueryResult | null;
  /** PNG data URL from the live canvas instance. */
  png: string | null;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** A4 landscape, in points. */
const PAGE = { width: 842, height: 595 };
const MARGIN = 32;

export async function dashboardToPdf(
  dashboard: Dashboard,
  snapshots: ChartSnapshot[],
  theme: Theme,
): Promise<Blob> {
  // jsPDF is a couple of hundred kilobytes and only ever used here.
  const { jsPDF } = await import('jspdf');
  const chrome = chromeFor(theme);

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const usableWidth = PAGE.width - MARGIN * 2;

  pdf.setFillColor(chrome.surface);
  pdf.rect(0, 0, PAGE.width, PAGE.height, 'F');
  pdf.setTextColor(chrome.ink);
  pdf.setFontSize(16);
  pdf.text(dashboard.name, MARGIN, MARGIN + 4);
  pdf.setFontSize(9);
  pdf.setTextColor(chrome.inkMuted);
  pdf.text(
    `Exported ${new Date().toLocaleString()} · generated locally, no data left this browser`,
    MARGIN,
    MARGIN + 20,
  );

  // Two charts per row at a 16:9-ish aspect — a faithful reproduction of the
  // on-screen grid would need per-tile scaling that reads worse on paper than a
  // clean two-column flow.
  const columnWidth = (usableWidth - 16) / 2;
  const rowHeight = columnWidth * 0.56;
  let x = MARGIN;
  let y = MARGIN + 36;

  for (const snapshot of snapshots) {
    if (!snapshot.png) continue;

    if (y + rowHeight > PAGE.height - MARGIN) {
      pdf.addPage();
      pdf.setFillColor(chrome.surface);
      pdf.rect(0, 0, PAGE.width, PAGE.height, 'F');
      x = MARGIN;
      y = MARGIN;
    }

    const title = snapshot.spec.options.title || snapshot.spec.encoding.y || 'Chart';
    pdf.setFontSize(10);
    pdf.setTextColor(chrome.ink);
    pdf.text(title, x, y - 4);
    pdf.addImage(snapshot.png, 'PNG', x, y, columnWidth, rowHeight, undefined, 'FAST');

    if (x === MARGIN) {
      x = MARGIN + columnWidth + 16;
    } else {
      x = MARGIN;
      y += rowHeight + 28;
    }
  }

  return pdf.output('blob');
}

// ---------------------------------------------------------------------------
// Standalone HTML
// ---------------------------------------------------------------------------

/**
 * A single self-contained HTML file.
 *
 * The charts go in as **inline SVG** rather than as a spec plus a bundled copy
 * of ECharts. Inlining the renderer would add roughly a megabyte to every export
 * and make the file depend on JavaScript running at all; SVG is already vector,
 * prints properly, and opens in anything. The spec and the underlying rows still
 * travel with it — in a `application/json` block and as a per-chart table — so
 * the file stays machine-readable and the numbers are checkable, which is the
 * part a colleague actually needs.
 */
export async function dashboardToHtml(
  dashboard: Dashboard,
  snapshots: ChartSnapshot[],
  theme: Theme,
): Promise<string> {
  const chrome = chromeFor(theme);

  const sections = await Promise.all(
    snapshots.map(async (snapshot) => {
      const title = escapeHtml(
        snapshot.spec.options.title || snapshot.spec.encoding.y || 'Chart',
      );
      const svg = snapshot.result ? await chartToSvg(snapshot.spec, snapshot.result, theme) : '';
      const table = snapshot.result ? renderTable(snapshot.result) : '';
      return `      <section class="card">
        <h2>${title}</h2>
        <div class="chart">${svg}</div>
        <details>
          <summary>Data (${snapshot.result?.rowCount ?? 0} rows)</summary>
          ${table}
        </details>
      </section>`;
    }),
  );

  const payload = {
    kind: 'data-workbench-dashboard',
    version: 1,
    exportedAt: new Date().toISOString(),
    dashboard: { ...dashboard, items: dashboard.items },
    data: snapshots.map((snapshot) => ({
      chartId: snapshot.spec.id,
      csv: snapshot.result ? toCsv(snapshot.result.columns, snapshot.result.rows) : '',
    })),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(dashboard.name)}</title>
<style>
  :root {
    --surface: ${chrome.surface};
    --ink: ${chrome.ink};
    --muted: ${chrome.inkMuted};
    --border: ${chrome.axis};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: var(--surface); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { margin-bottom: 20px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .meta { color: var(--muted); font-size: 12px; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow: hidden; }
  h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
  .chart { overflow-x: auto; }
  .chart svg { max-width: 100%; height: auto; }
  details { margin-top: 8px; font-size: 12px; color: var(--muted); }
  .table-wrap { overflow-x: auto; margin-top: 8px; }
  table { border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid var(--border); padding: 3px 8px; text-align: left; white-space: nowrap; }
  th { color: var(--ink); font-weight: 600; }
  footer { margin-top: 24px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(dashboard.name)}</h1>
    <p class="meta">Exported ${new Date().toLocaleString()} from the in-browser Data Workbench.</p>
  </header>
  <main class="grid">
${sections.join('\n')}
  </main>
  <footer>This file is self-contained: the charts are inline SVG and the data is embedded below. Nothing here loads from the network.</footer>
  <script type="application/json" id="workbench-dashboard">${escapeForScript(JSON.stringify(payload))}</script>
</body>
</html>
`;
}

/** First rows only — an export is a summary, not a data dump. */
const HTML_TABLE_ROWS = 100;

function renderTable(result: QueryResult): string {
  const head = result.columns.map((column) => `<th>${escapeHtml(column.name)}</th>`).join('');
  const body = result.rows
    .slice(0, HTML_TABLE_ROWS)
    .map(
      (row) =>
        `<tr>${row.map((value) => `<td>${escapeHtml(value === null ? '' : String(value))}</td>`).join('')}</tr>`,
    )
    .join('');
  const note =
    result.rows.length > HTML_TABLE_ROWS
      ? `<p class="meta">Showing the first ${HTML_TABLE_ROWS} of ${result.rows.length} rows; the full set is in the embedded JSON.</p>`
      : '';
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${note}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Make JSON safe inside a `<script>` element.
 *
 * The parser ends the element at the first literal `</script`, wherever it
 * appears — including inside a string — so a user's data containing that text
 * would break the exported page. `<!--` is escaped for the same reason.
 */
function escapeForScript(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}
