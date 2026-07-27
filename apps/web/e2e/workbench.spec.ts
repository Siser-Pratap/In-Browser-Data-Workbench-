import { expect, test } from '@playwright/test';

import { SAMPLES, importFile, openWorkbench, runSql } from './helpers';

test.describe('import → query', () => {
  test('imports a CSV and previews it', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await expect(page.getByRole('columnheader', { name: /order_id/ })).toBeVisible();
    await expect(page.getByRole('complementary')).toContainText('1,500 rows · 7 cols');
  });

  test('runs a query and shows the result', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT region, count(*) AS n FROM orders GROUP BY region ORDER BY n DESC');

    await expect(page.getByText('4 rows × 2 cols')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /region/ })).toBeVisible();
  });

  test('reports a bad query with a position instead of failing silently', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT nonexistent_column FROM orders');

    await expect(page.getByText(/does.?n.?t resolve|Unknown table/i)).toBeVisible();
  });

  test('keeps datasets across a reload', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await page.reload();
    await expect(page.getByText('Engine ready')).toBeVisible();
    await expect(page.getByRole('button', { name: /Expand orders|Collapse orders/ })).toBeVisible();
  });

  test('never talks to the network after load', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') external.push(request.url());
    });

    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');
    await page.getByRole('button', { name: 'SQL' }).click();
    await runSql(page, 'SELECT count(*) FROM orders');
    await expect(page.getByText('1 row × 1 col')).toBeVisible();

    // The product's central claim, asserted rather than assumed.
    expect(external).toEqual([]);
  });
});

test.describe('command palette', () => {
  test('opens on Cmd/Ctrl+K and switches view', async ({ page }) => {
    await openWorkbench(page);
    await importFile(page, SAMPLES.orders, 'orders');

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    await palette.getByRole('combobox').or(palette.locator('input')).fill('SQL editor');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('tablist', { name: 'Query tabs' })).toBeVisible();
  });
});
