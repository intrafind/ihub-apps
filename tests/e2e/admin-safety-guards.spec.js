// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: the admin safety guards (ID-B1, ID-B2, ID-B4).
 *
 * Runs on its own server and contents directory, fresh on every run
 * (`npm run test:e2e:admin-safety`, tests/config/playwright.admin-safety.config.js):
 * the default local admin (`admin` / `password123`) is the only administrator,
 * which is exactly the state the guards protect.
 *
 * - Unticking Local sign-in on /admin/auth while signed in locally is refused;
 *   the configuration is unchanged and a fresh browser can still sign in.
 * - Demoting yourself as the only admin is refused on the user editor; your own
 *   Enabled switch is disabled, and the API refuses deactivating yourself.
 * - Deleting a group another group inherits from is refused; the dialog names it.
 */

const ADMIN = { username: 'admin', password: 'password123' };
const PARENT = 'e2e-safety-parent';
const CHILD = 'e2e-safety-child';

test.describe('Admin safety guards', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  /** The default admin's users.json id. */
  async function adminUserId(page) {
    const response = await page.request.get('/api/admin/auth/users');
    expect(response.ok()).toBeTruthy();
    const { users } = await response.json();
    const admin = Object.values(users).find(user => user.username === ADMIN.username);
    expect(admin, 'the default admin exists').toBeTruthy();
    return admin.id;
  }

  test('turning off Local sign-in while signed in locally is refused', async ({
    page,
    playwright,
    baseURL
  }) => {
    await page.goto('/admin/auth');
    const localRow = page
      .locator('div.flex.items-start')
      .filter({ has: page.getByText('Local Authentication', { exact: true }) });
    const localSwitch = localRow.getByRole('checkbox');
    await expect(localSwitch).toBeChecked();
    await localSwitch.uncheck();

    const saved = page.waitForResponse(
      response =>
        response.url().includes('/api/admin/configs/platform') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    const response = await saved;
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe('AUTH_LOCKOUT');

    await expect(page.getByTestId('admin-auth-message')).toContainText(
      'turn off the sign-in method you are using'
    );

    const config = await page.request.get('/api/admin/configs/platform');
    expect((await config.json()).localAuth.enabled).toBe(true);

    const fresh = await playwright.request.newContext({ baseURL });
    const login = await fresh.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'a fresh browser can still sign in locally').toBeTruthy();
    await fresh.dispose();
  });

  test('demoting yourself as the only admin is refused; your own Enabled switch is locked', async ({
    page
  }) => {
    const id = await adminUserId(page);
    await page.goto(`/admin/users/${id}`);

    await expect(page.getByLabel('Enabled')).toBeDisabled();
    await expect(page.getByText('You cannot deactivate your own account.')).toBeVisible();

    await page.getByRole('button', { name: /^Remove admin/i }).click();
    await page.getByRole('button', { name: 'Save User' }).click();

    // The page also shows the demo-account warning as an alert; pick the save error.
    await expect(
      page.getByRole('alert').filter({ hasText: 'Could not save the user' })
    ).toContainText('leave no active administrator who can sign in');
    await expect(page).toHaveURL(new RegExp(`/admin/users/${id}$`));

    const users = await (await page.request.get('/api/admin/auth/users')).json();
    expect(users.users[id].internalGroups).toContain('admins');
  });

  test('deactivating yourself through the API is refused', async ({ page }) => {
    const id = await adminUserId(page);

    const response = await page.request.put(`/api/admin/auth/users/${id}`, {
      data: { active: false }
    });

    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe('SELF_LOCKOUT');
  });

  test('deleting a group another group inherits from is refused and names it', async ({ page }) => {
    for (const group of [
      { id: PARENT, name: 'E2E safety parent', permissions: {} },
      { id: CHILD, name: 'E2E safety child', permissions: {}, inherits: [PARENT] }
    ]) {
      const created = await page.request.post('/api/admin/groups', { data: group });
      expect(created.ok(), `create ${group.id}`).toBeTruthy();
    }

    try {
      await page.goto('/admin/groups');
      await page
        .getByRole('row', { name: /E2E safety parent/ })
        .getByRole('button', { name: 'Delete' })
        .click();
      const dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Confirm' }).click();

      await expect(dialog.getByText('Cannot delete group')).toBeVisible();
      await expect(dialog.getByTestId('group-delete-dependants')).toContainText('E2E safety child');
      await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close' }).click();

      const groups = await (await page.request.get('/api/admin/groups')).json();
      expect(groups.groups[PARENT]).toBeTruthy();
    } finally {
      await page.request.delete(`/api/admin/groups/${CHILD}`);
      await page.request.delete(`/api/admin/groups/${PARENT}`);
    }
  });
});
