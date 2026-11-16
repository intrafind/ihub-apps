// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: destructive admin actions ask a named confirmation, and no
 * native browser dialog (alert / confirm / prompt) appears anywhere.
 *
 *   - Deleting a marketplace registry names it; the shipped registry asks for
 *     its id to be typed; Cancel and Escape delete nothing (AX-B14).
 *   - "Disable All" on Models states the count and the default-model
 *     consequence; Cancel sends no `_toggle` (AI-B2).
 *   - Choosing a backup ZIP sends no `/_import` request until the host name is
 *     typed (PL-B1). The import request is intercepted and answered with 204:
 *     the real restore never runs.
 *
 * Every write the tests could trigger is intercepted (`route.fulfill`), and the
 * lists are served from fixtures, so the tests change nothing on the server.
 * Signs in as the default local admin (`admin` / `password123`).
 */

const ADMIN = { username: 'admin', password: 'password123' };

const REGISTRIES = [
  {
    id: 'ihub-official',
    name: 'iHub Official Marketplace',
    source: 'https://example.invalid/catalog.json',
    auth: { type: 'none' },
    enabled: true
  },
  {
    id: 'e2e-team-catalog',
    name: 'E2E team catalog',
    source: 'https://example.invalid/team.json',
    auth: { type: 'none' },
    enabled: true
  }
];

const model = (id, extra = {}) => ({
  id,
  modelId: id,
  name: { en: `E2E model ${id}` },
  description: { en: '' },
  provider: 'openai',
  enabled: true,
  ...extra
});
const MODELS = [
  model('e2e-default', { default: true }),
  model('e2e-second'),
  model('e2e-off', { enabled: false })
];

async function signIn(request) {
  const response = await request.post('/api/auth/local/login', { data: ADMIN });
  expect(response.ok()).toBeTruthy();
}

test.describe('Admin confirmations', () => {
  /** Native dialogs seen during the test; must stay empty. */
  let nativeDialogs;

  test.beforeEach(async ({ page }) => {
    nativeDialogs = [];
    page.on('dialog', async dialog => {
      if (dialog.type() !== 'beforeunload') {
        nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      }
      await dialog.dismiss();
    });
    // The first-visit disclaimer would sit over every click.
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    await signIn(page.request);
  });

  test.afterEach(() => {
    expect(nativeDialogs, 'no native alert/confirm/prompt may appear').toEqual([]);
  });

  test('deleting a registry names it; Cancel and Escape delete nothing', async ({ page }) => {
    const deletes = [];
    await page.route('**/api/admin/marketplace/registries**', async route => {
      const request = route.request();
      if (request.method() === 'DELETE') {
        deletes.push(request.url());
        return route.fulfill({ status: 204 });
      }
      if (request.method() === 'GET' && /\/registries\/?(\?.*)?$/.test(request.url())) {
        return route.fulfill({ status: 200, json: { items: REGISTRIES } });
      }
      return route.continue();
    });

    await page.goto('/admin/marketplace/registries');
    const officialRow = page.getByRole('row', { name: /iHub Official Marketplace/ });
    await expect(officialRow).toBeVisible();

    await officialRow.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('alertdialog', {
      name: 'Delete registry "iHub Official Marketplace"?'
    });
    await expect(dialog).toBeVisible();
    // The shipped registry asks for its id; the field has focus.
    const tokenField = dialog.getByRole('textbox');
    await expect(tokenField).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await officialRow.getByRole('button', { name: 'Delete' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Another registry: a named confirm, focus on Cancel, Escape cancels.
    const teamRow = page.getByRole('row', { name: /E2E team catalog/ });
    await teamRow.getByRole('button', { name: 'Delete' }).click();
    const teamDialog = page.getByRole('alertdialog', {
      name: 'Delete registry "E2E team catalog"?'
    });
    await expect(teamDialog).toBeVisible();
    await expect(teamDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(teamDialog).toBeHidden();

    expect(deletes).toEqual([]);
  });

  test('Disable All on Models states the count; Cancel sends no write', async ({ page }) => {
    const toggles = [];
    await page.route('**/api/admin/models/**/_toggle', async route => {
      toggles.push(route.request().url());
      return route.fulfill({ status: 200, json: { enabled: false, ids: [] } });
    });
    await page.route(/\/api\/admin\/models(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({ status: 200, json: { items: MODELS } });
    });

    await page.goto('/admin/models');
    await expect(page.getByText('E2E model e2e-default')).toBeVisible();

    await page.getByRole('button', { name: 'More model actions' }).click();
    await page.getByRole('menuitem', { name: 'Disable All' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Disable all models?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2 of 3 models are enabled now and will be disabled.');
    await expect(dialog).toContainText('"E2E model e2e-default" is the default now');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(toggles).toEqual([]);
  });

  test('choosing a backup ZIP sends no import until the host name is typed', async ({ page }) => {
    const imports = [];
    // Never hit the real restore: answer the import ourselves.
    await page.route('**/api/admin/backup/_import', async route => {
      imports.push(route.request().method());
      return route.fulfill({ status: 204 });
    });

    await page.goto('/admin/backup');
    await expect(page.getByTestId('backup-sensitivity-callout')).toContainText(
      'Store the export like a key'
    );

    // The picker is one keyboard-reachable button; the file input is not in the tab order.
    const pickerButton = page.getByRole('button', { name: 'Import Configuration' });
    await expect(pickerButton).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveAttribute('tabindex', '-1');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK\u0003\u0004 e2e placeholder, never uploaded to the real restore')
    });

    const dialog = page.getByRole('alertdialog', {
      name: 'Replace all contents with "e2e-backup.zip"?'
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('contents/.backups');
    expect(imports).toEqual([]);

    const host = await page.evaluate(() => window.location.host);
    await expect(dialog.locator('code', { hasText: host })).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Import and replace' });
    const field = dialog.getByRole('textbox');
    await expect(field).toBeFocused();

    await field.fill('not-this-server');
    await confirm.click();
    expect(imports).toEqual([]);

    // Cancel drops the file; nothing was sent.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(imports).toEqual([]);

    // Choose again, type the host: exactly one import request.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK\u0003\u0004 e2e placeholder')
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill(host);
    await dialog.getByRole('button', { name: 'Import and replace' }).click();
    await expect(dialog).toBeHidden();
    expect(imports).toEqual(['POST']);
  });
});
