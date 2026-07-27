import { expect, test } from '@playwright/test';

import { SAMPLES, importFile, openWorkbench, runSql } from './helpers';

/**
 * The chart and dashboard happy path.
 *
 * Deliberately end-to-end rather than a unit test of the spec compiler (which
 * has its own): the parts that only break in a real browser are ECharts
 * actually drawing, the dashboard grid mounting, and the export producing a
 * file — none of which jsdom can tell you anything about.
 */
test.describe('charts', () => {
  test('builds a chart from a query result', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(
      page,
      'SELECT region, sum(quantity * unit_price) AS revenue FROM orders GROUP BY region',
    );
    await expect(page.getByText('4 rows × 2 cols')).toBeVisible();

    await page.getByRole('tab', { name: 'chart' }).click();

    // A category plus a number should infer a bar chart, not leave the panel empty.
    await expect(page.getByRole('button', { name: 'Bar', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('echart').first()).toBeVisible();
  });

  test('switching chart type re-renders', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');
    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT region, count(*) AS n FROM orders GROUP BY region');
    await page.getByRole('tab', { name: 'chart' }).click();
    await expect(page.getByTestId('echart').first()).toBeVisible();

    await page.getByRole('button', { name: 'Pie / donut' }).click();
    await expect(page.getByRole('button', { name: 'Pie / donut' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('echart').first()).toBeVisible();
  });

  test('a big number renders as a figure, not a chart', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');
    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT sum(quantity) AS total_units FROM orders');
    await page.getByRole('tab', { name: 'chart' }).click();

    await expect(page.getByRole('button', { name: 'Big number' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('echart')).toHaveCount(0);
  });
});

test.describe('dashboards', () => {
  test('adds a chart to a dashboard and it survives a reload', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT category, count(*) AS n FROM orders GROUP BY category');
    await page.getByRole('tab', { name: 'chart' }).click();
    await expect(page.getByTestId('echart').first()).toBeVisible();

    await page.getByRole('button', { name: /Add to/ }).click();
    await page.getByRole('menuitem', { name: 'New dashboard…' }).click();

    await page.getByRole('button', { name: 'Dashboards' }).click();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByTestId('echart').first()).toBeVisible();

    // Dashboards live in IndexedDB, so a reload is the real test of persistence.
    await page.reload();
    await expect(page.getByText('Engine ready')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByTestId('echart').first()).toBeVisible();
  });

  test('exports the dashboard as a standalone HTML file', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');
    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT region, count(*) AS n FROM orders GROUP BY region');
    await page.getByRole('tab', { name: 'chart' }).click();
    await expect(page.getByTestId('echart').first()).toBeVisible();
    await page.getByRole('button', { name: /Add to/ }).click();
    await page.getByRole('menuitem', { name: 'New dashboard…' }).click();
    await page.getByRole('button', { name: 'Dashboards' }).click();
    await expect(page.getByTestId('echart').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export/ }).first().click();
    await page.getByRole('menuitem', { name: 'Standalone HTML' }).click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.html$/);
  });
});

test.describe('result export', () => {
  test('exports a result as CSV', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');
    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT region, count(*) AS n FROM orders GROUP BY region');
    await expect(page.getByText('4 rows × 2 cols')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export/ }).click();
    await page.getByRole('menuitem', { name: 'CSV' }).click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
  });
});
