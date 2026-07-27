import { expect, test } from '@playwright/test';

import { openWorkbench } from './helpers';

test.describe('onboarding', () => {
  test('shows the tour on a first visit and not again after dismissal', async ({ page }) => {
    await openWorkbench(page, { dismissTour: false });

    const tour = page.getByRole('dialog', { name: /never leaves this browser/i });
    await expect(tour).toBeVisible();
    await tour.getByRole('button', { name: 'Skip' }).click();
    await expect(tour).toBeHidden();

    await page.reload();
    await expect(page.getByText('Engine ready')).toBeVisible();
    await expect(page.getByRole('dialog', { name: /never leaves this browser/i })).toBeHidden();
  });

  test('loads the sample data and lands on a runnable query', async ({ page }) => {
    await openWorkbench(page);

    await page.getByRole('button', { name: /Try it with sample data/ }).click();

    // Both tables, plus a starter query already run.
    await expect(page.getByRole('button', { name: /(Expand|Collapse) orders/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /(Expand|Collapse) customers/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Revenue by region/ })).toBeVisible();
    await expect(page.getByText(/rows × 3 cols/)).toBeVisible();
  });
});

test.describe('privacy', () => {
  test('telemetry is off by default and can be inspected', async ({ page }) => {
    await openWorkbench(page);

    await page.getByRole('button', { name: 'Privacy and usage settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Privacy' });
    await expect(dialog).toBeVisible();

    const optIn = dialog.getByRole('checkbox');
    await expect(optIn).not.toBeChecked();

    await optIn.check();
    await expect(dialog.getByText('Everything recorded so far')).toBeVisible();
  });
});
