// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: admin pages ask "Leave without saving?" before unsaved edits are
 * lost (CU-B4, AX-B6, OB-B16, PL-B14, IN-B12, UX-N1).
 *
 * Representative pages: Security (an AdminSettingsPage page whose sections save
 * on their own), the visual workflow editor (fresh contents ship the
 * `approval-workflow`), translation overrides (Localization) and UI
 * Customization (in-page tabs that only change the query string).
 *
 * Signs in as the default local admin (`admin` / `password123`). The one test
 * that saves (CORS max age) restores the stored value at the end, so runs leave
 * the configuration as they found it. Never run side by side with other specs
 * that edit the CORS settings.
 */

const ADMIN = { username: 'admin', password: 'password123' };

/** The leave dialog. */
const leaveDialog = page => page.getByRole('alertdialog', { name: 'Leave without saving?' });

/** The "Overview" entry of the admin sidebar. */
const sidebarOverview = page =>
  page.getByRole('navigation', { name: 'Admin navigation' }).locator('a[href$="/admin"]').first();

test.describe('Admin unsaved-changes guard', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  test.describe('Security (AdminSettingsPage)', () => {
    const maxAge = page => page.locator('#corsMaxAge');

    async function openSecurity(page) {
      await page.goto('/admin/security');
      await expect(maxAge(page)).toBeVisible();
    }

    test('a just-loaded page leaves without asking', async ({ page }) => {
      await openSecurity(page);
      await sidebarOverview(page).click();
      await expect(page).toHaveURL(/\/admin\/?$/);
      await expect(leaveDialog(page)).toHaveCount(0);
    });

    test('one typed character: the sidebar asks; Stay keeps it, Discard leaves', async ({
      page
    }) => {
      await openSecurity(page);
      const original = await maxAge(page).inputValue();
      await maxAge(page).fill(`${original}1`);

      // The section nav marks the edited section.
      await expect(
        page
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('button', { name: /CORS.*unsaved/ })
      ).toBeVisible();

      await sidebarOverview(page).click();
      const dialog = leaveDialog(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Your changes will be lost.');
      await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused();

      await dialog.getByRole('button', { name: 'Stay' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/admin\/security/);
      await expect(maxAge(page)).toHaveValue(`${original}1`);

      await sidebarOverview(page).click();
      await leaveDialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(/\/admin\/?$/);
    });

    test('browser Back/Forward asks too, and the page stays where it was', async ({ page }) => {
      // Build in-app history (page.goto between pages would be a document
      // load, which only the browser's own beforeunload prompt can stop):
      // Security -> Overview (in-app link) -> Back to Security.
      await openSecurity(page);
      await sidebarOverview(page).click();
      await expect(page).toHaveURL(/\/admin\/?$/);
      await page.goBack();
      await expect(maxAge(page)).toBeVisible();

      const original = await maxAge(page).inputValue();
      await maxAge(page).fill(`${original}1`);

      await page.goForward();
      await expect(leaveDialog(page)).toBeVisible();
      await expect(page).toHaveURL(/\/admin\/security/);
      await expect(maxAge(page)).toHaveValue(`${original}1`);

      await leaveDialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(/\/admin\/?$/);
    });

    test('save, then navigate: no dialog', async ({ page }) => {
      await openSecurity(page);
      const original = await maxAge(page).inputValue();
      const section = page.locator('#settings-section-cors');
      const save = section.getByRole('button', { name: 'Save Configuration' });

      try {
        await maxAge(page).fill(String(Number(original || 0) + 1));
        await save.click();
        await expect(section.getByText('CORS configuration saved successfully')).toBeVisible();

        await sidebarOverview(page).click();
        await expect(page).toHaveURL(/\/admin\/?$/);
        await expect(leaveDialog(page)).toHaveCount(0);
      } finally {
        // Put the stored value back.
        await openSecurity(page);
        await maxAge(page).fill(original);
        await page
          .locator('#settings-section-cors')
          .getByRole('button', { name: 'Save Configuration' })
          .click();
        await expect(
          page.locator('#settings-section-cors').getByText('CORS configuration saved successfully')
        ).toBeVisible();
      }
    });
  });

  test.describe('UI Customization tabs (UX-N1)', () => {
    test('switching an in-page tab with unsaved edits does not ask', async ({ page }) => {
      await page.goto('/admin/ui');
      const firstField = page.getByRole('tabpanel').locator('input[type="text"]').first();
      await expect(firstField).toBeVisible();
      await firstField.fill(`${await firstField.inputValue()}x`);

      await page.getByRole('tab', { name: 'Navigation' }).click();
      await expect(page).toHaveURL(/\/admin\/ui\?tab=navigation/);
      await expect(leaveDialog(page)).toHaveCount(0);

      // Leaving the page still asks.
      await sidebarOverview(page).click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(/\/admin\/?$/);
    });
  });

  test.describe('Translation overrides', () => {
    test('an edited, unsaved translation asks before leaving', async ({ page }) => {
      await page.goto('/admin/localization');
      // Fresh contents have no overrides: show every key.
      const changedOnly = page.getByRole('checkbox', { name: /Changed only/ });
      await expect(changedOnly).toBeVisible();
      if (await changedOnly.isChecked()) await changedOnly.uncheck();

      const firstText = page.locator('ul textarea').first();
      await expect(firstText).toBeVisible();
      await firstText.fill(`${await firstText.inputValue()}x`);

      await sidebarOverview(page).click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Stay' }).click();
      await expect(page).toHaveURL(/\/admin\/localization/);

      await sidebarOverview(page).click();
      await leaveDialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(/\/admin\/?$/);
    });
  });

  test.describe('Visual workflow editor (AX-B6)', () => {
    const EDITOR = '/admin/workflows/approval-workflow/edit';
    const WORKFLOW_PAGE = /\/admin\/workflows\/approval-workflow\/?$/;

    /** Opens the canvas from the workflow page, so Back has an in-app entry to return to. */
    async function openEditor(page) {
      await page.goto('/admin/workflows/approval-workflow');
      await page.getByRole('button', { name: 'Open visual editor' }).click();
      await expect(page).toHaveURL(new RegExp(EDITOR));
      await expect(page.getByRole('textbox', { name: 'Search steps...' })).toBeVisible();
    }

    /** Adds a step from the palette: an unsaved canvas edit. */
    async function addStep(page) {
      const palette = page.getByRole('textbox', { name: 'Search steps...' }).locator('xpath=..');
      await palette.getByRole('button').first().click();
    }

    test('an unchanged canvas leaves through its Back button at once', async ({ page }) => {
      await openEditor(page);
      await page.getByRole('button', { name: /Back/ }).first().click();
      await expect(page).toHaveURL(WORKFLOW_PAGE);
      await expect(leaveDialog(page)).toHaveCount(0);
    });

    test('Back and the Chat integration link ask after a canvas edit', async ({ page }) => {
      await openEditor(page);
      await addStep(page);

      await page.getByRole('button', { name: /Back/ }).first().click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Stay' }).click();
      await expect(page).toHaveURL(new RegExp(EDITOR));

      await page.getByRole('link', { name: 'Chat integration' }).click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(WORKFLOW_PAGE);
    });

    test('browser Back asks after a canvas edit', async ({ page }) => {
      await openEditor(page);
      await addStep(page);
      await page.goBack();
      await expect(leaveDialog(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(EDITOR));
      await leaveDialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(WORKFLOW_PAGE);
    });
  });
});
