import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Runs against a **production** build rather than `next dev`, because the two
 * differ in exactly the places this app is unusual: the lazily-imported Monaco
 * and ECharts chunks, the DuckDB WASM assets copied into `public/`, and the
 * COOP/COEP headers. A suite that only ever passes in dev would miss a broken
 * production chunk entirely.
 */
export default defineConfig({
  testDir: './e2e',
  // The workbench boots a WASM engine and imports files; the default 30s is
  // tight on a cold CI machine.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: every spec drives the same origin-scoped OPFS and IndexedDB, so
  // parallel specs would clobber each other's workspace.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm build && pnpm start --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
