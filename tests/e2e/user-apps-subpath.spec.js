// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * Personal apps on a deployment under a path prefix (`/ihub`), run by the
 * subpath suite (`playwright.subpath.config.js`, the production build behind a
 * proxy that answers only under the prefix).
 *
 * `/apps/new` and `/apps/:appId/edit` are routes of their own next to
 * `/apps/:appId`. A route the pre-paint script of client/index.html does not
 * know is taken for the base path on a cold load, and the page then asks
 * `/apps/api/...` and shows "Unable to connect to the server". So both pages
 * are loaded cold, and so is the chat of a personal app; every request they
 * make must stay under the prefix and be answered.
 *
 * No chat answer is asserted here; `user-apps.spec.js` does that, and loads
 * the same pages at the root. This spec
 * switches the feature `userApps` on for its run and puts it back, so it runs
 * only where the subpath config started the server.
 */

const BASE = (process.env.CRAWL_BASE_PATH || '').replace(/\/$/, '');
const ADMIN = { username: 'admin', password: 'password123' };
const NAME = `E2E UA Subpath ${Date.now().toString(36)}`;

test.skip(!BASE, 'Switches a feature of its server: runs only through npm run test:e2e:subpath');

/**
 * Records what must not happen on a page under a prefix: a request of the app
 * that leaves the prefix, a request the server refuses, an uncaught error.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} origin - The origin of the deployment
 * @returns {string[]} The problems, filled while the page runs
 */
function watchRequests(page, origin) {
  const problems = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) {
      problems.push(`${request.method()} ${url.pathname} ignores the base path ${BASE}`);
    }
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) {
      problems.push(`${response.request().method()} ${url.pathname} answered ${response.status()}`);
    }
  });
  page.on('pageerror', error => problems.push(`uncaught: ${error.message}`));
  return problems;
}

test.describe('Personal apps under the base path', () => {
  let featureWasOn = false;
  let appId = null;

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await context.request.post(`${BASE}/api/auth/local/login`, { data: ADMIN });
    expect(login.ok()).toBeTruthy();
    const features = await (await context.request.get(`${BASE}/api/admin/features`)).json();
    featureWasOn = features.features?.find(feature => feature.id === 'userApps')?.enabled === true;
    const switched = await context.request.put(`${BASE}/api/admin/features`, {
      data: { userApps: true }
    });
    expect(switched.ok(), await switched.text()).toBeTruthy();
  });

  test.afterEach(async ({ context }) => {
    if (appId) await context.request.delete(`${BASE}/api/admin/user-apps/${appId}`);
    if (!featureWasOn) {
      await context.request.put(`${BASE}/api/admin/features`, { data: { userApps: false } });
    }
  });

  test('cold loads of "New app", of the editor and of the chat of a personal app stay under the base path', async ({
    page,
    baseURL
  }) => {
    const created = await page.request.post(`${BASE}/api/apps`, {
      data: {
        language: 'en',
        origin: 'blank',
        name: { en: NAME },
        description: { en: 'Created under a prefix.' },
        system: { en: 'You answer briefly.' }
      }
    });
    expect(created.status(), await created.text()).toBe(201);
    appId = (await created.json()).id;
    // The address of the new app, as the server names it, is under the prefix too.
    expect(created.headers().location).toBe(`${BASE}/api/apps/${appId}`);

    const problems = watchRequests(page, new URL(baseURL).origin);

    // A cold load of the create page.
    await page.goto(`${BASE}/apps/new`);
    await expect(page.getByRole('textbox', { name: 'Your description' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start empty' })).toBeVisible();
    await expect(page.getByText('Unable to connect to the server')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`${BASE}/apps/new`);
    await page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the create page').toEqual([]);

    // A cold load of the editor of an app.
    await page.goto(`${BASE}/apps/${appId}/edit`);
    await expect(page.getByRole('textbox', { name: 'Name' }).first()).toHaveValue(NAME);
    await expect(page.getByTestId('user-app-state')).toHaveText('Only you');
    await expect(page.getByText('Unable to connect to the server')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`${BASE}/apps/${appId}/edit`);
    await page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the editor').toEqual([]);

    // A cold load of the chat of the app.
    await page.goto(`${BASE}/apps/${appId}`);
    await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
    await expect(page.locator('main textarea.chat-input-textarea:visible')).toBeEnabled();
    expect(new URL(page.url()).pathname).toBe(`${BASE}/apps/${appId}`);
    await page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the chat').toEqual([]);
  });
});
