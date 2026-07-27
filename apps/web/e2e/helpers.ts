import { expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const SAMPLES = {
  orders: fileURLToPath(new URL('../public/samples/orders.csv', import.meta.url)),
  customers: fileURLToPath(new URL('../public/samples/customers.csv', import.meta.url)),
};

/**
 * Open the workbench with a clean slate.
 *
 * OPFS and IndexedDB are origin-scoped and survive a page reload by design —
 * that's the feature — so each spec has to wipe them or it inherits whatever the
 * previous one imported.
 */
export async function openWorkbench(
  page: Page,
  { dismissTour = true }: { dismissTour?: boolean } = {},
): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('datasets', { recursive: true });
    } catch {
      // Nothing stored yet.
    }
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('workbench');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByText('Engine ready')).toBeVisible();

  // Wiping localStorage makes every spec a "first visit", so the tour opens as
  // a modal over whatever the spec was about to do. Specs that are *about* the
  // tour opt out.
  if (dismissTour) {
    const skip = page.getByRole('dialog').getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
  }
}

/** Import a file through the hidden picker and confirm the import dialog. */
export async function importFile(page: Page, path: string, table: string): Promise<void> {
  await page.getByTestId('file-picker').setInputFiles(path);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  // The sidebar's expand toggle is the most stable signal that the table has
  // actually landed in the catalogue, not merely that the dialog closed.
  await expect(
    page.getByRole('button', { name: new RegExp(`(Expand|Collapse) ${table}`) }),
  ).toBeVisible();
}

/** Type SQL into Monaco and run it. */
export async function runSql(page: Page, sql: string): Promise<void> {
  const editor = page.getByTestId('sql-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  // `insertText` rather than `type`: Monaco's autocomplete accepts on some
  // keystrokes, which would silently rewrite the query being tested.
  await page.keyboard.insertText(sql);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
}
