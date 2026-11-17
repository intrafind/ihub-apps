// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * Short links on a deployment under a path prefix (`/ihub`), run by the subpath
 * suite (`playwright.subpath.config.js`): the proxy in front of the server answers
 * only under the prefix, so a link that forgets it fails here as it would in
 * production.
 *
 * - A cold load of the short-link admin page stays under the prefix (CU-B9).
 * - "Copy link" copies `…/ihub/s/<code>` (CU-B9).
 * - Following `/ihub/s/<code>` redirects to `/ihub/apps/…`, not `/apps/…` (CU-B10),
 *   and the prefilled prompt survives the redirect (CU-B2).
 */

const BASE = (process.env.CRAWL_BASE_PATH || '').replace(/\/$/, '');
const ADMIN = { username: 'admin', password: 'password123' };
const CODE = `e2esub${Date.now().toString(36)}`;

test.describe('Short links under the base path', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await context.request.post(`${BASE}/api/auth/local/login`, { data: ADMIN });
    expect(login.ok()).toBeTruthy();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    await context.request.post(`${BASE}/api/auth/local/login`, { data: ADMIN });
    await context.request.delete(`${BASE}/api/shortlinks/${CODE}`);
    await context.close();
  });

  test('create, copy and follow a short link without leaving the base path', async ({
    context,
    page,
    baseURL
  }) => {
    const created = await context.request.post(`${BASE}/api/shortlinks`, {
      data: { code: CODE, appId: 'chat', params: { prefill: 'Hello there' } }
    });
    expect(created.ok()).toBeTruthy();

    // The redirect itself keeps the base path.
    const redirect = await context.request.get(`${BASE}/s/${CODE}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers().location).toBe(`${BASE}/apps/chat?prefill=Hello+there`);

    // A cold load of the admin list stays under the base path.
    await page.goto(`${BASE}/admin/shortlinks`);
    await expect(page.getByRole('heading', { name: 'Short Links Management' })).toBeVisible();
    expect(new URL(page.url()).pathname.startsWith(`${BASE}/admin/shortlinks`)).toBe(true);

    // "Copy link" puts the link with the base path on the clipboard.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
    const row = page.getByRole('row', { name: new RegExp(CODE) });
    await row.getByRole('button', { name: 'Copy link' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${new URL(baseURL).origin}${BASE}/s/${CODE}`);

    // Following the link opens the app under the base path, prompt included.
    await page.goto(`${BASE}/s/${CODE}`);
    await expect(page).toHaveURL(new RegExp(`${BASE}/apps/chat`));
    expect(new URL(page.url()).pathname.startsWith(`${BASE}/apps/chat`)).toBe(true);
  });
});
