/**
 * Enforce the initial-JavaScript budget.
 *
 * The plan's number is under 300 KB of JS before any lazy chunk. That budget is
 * what keeps the app honest about the heavy things it depends on — Monaco,
 * ECharts, DuckDB and jsPDF are all several times the budget on their own, and
 * all four are behind dynamic imports precisely because of it. Without a check
 * in CI, one convenient top-level import quietly undoes that.
 *
 * "First load" here means what the browser must download and parse to render
 * the route: the shared runtime chunks plus the route's own — exactly the set
 * Next lists in `app-build-manifest.json`.
 *
 * Usage: node scripts/check-bundle-size.mjs [--budget-kb 300]
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, '.next', 'app-build-manifest.json');
const ROUTE = '/page';

const budgetIndex = process.argv.indexOf('--budget-kb');
const BUDGET_KB = budgetIndex === -1 ? 300 : Number(process.argv[budgetIndex + 1]);

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch {
  console.error(`Could not read ${MANIFEST}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const files = manifest.pages?.[ROUTE];
if (!Array.isArray(files)) {
  console.error(`The build manifest has no entry for ${ROUTE}.`);
  process.exit(1);
}

// Gzipped, because that's what actually crosses the wire — and because it's the
// number `next build` prints, so the two agree and there's only one figure to
// reason about.
let total = 0;
const rows = [];
for (const file of files) {
  if (!file.endsWith('.js')) continue;
  const bytes = gzipSync(readFileSync(join(ROOT, '.next', file))).length;
  total += bytes;
  rows.push({ file, 'gzip KB': +(bytes / 1024).toFixed(1) });
}

rows.sort((a, b) => b["gzip KB"] - a["gzip KB"]);
console.table(rows);

const totalKb = total / 1024;
const verdict = totalKb <= BUDGET_KB ? 'PASS' : 'FAIL';
console.log(
  `\n[${verdict}] initial JS for ${ROUTE}: ${totalKb.toFixed(1)} KB (budget ${BUDGET_KB} KB)`,
);

if (verdict === 'FAIL') {
  console.error(
    '\nSomething heavy reached the initial bundle. Check for a new top-level import of\n' +
      'monaco-editor, echarts, jspdf, @duckdb/duckdb-wasm or xlsx — each of those belongs\n' +
      'behind a dynamic import (see src/components/workbench/lazy.tsx).',
  );
  process.exit(1);
}
