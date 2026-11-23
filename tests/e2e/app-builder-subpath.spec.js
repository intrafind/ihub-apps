// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * "New app" and the app editor on a deployment under a path prefix (`/ihub`),
 * run by the subpath suite (`playwright.subpath.config.js`, the production
 * build behind a proxy that answers only under the prefix).
 *
 * `/admin/apps/new` is a route of its own in front of `/admin/apps/:appId`. A
 * route the pre-paint script of client/index.html does not know is taken for
 * the base path on a cold load, and the page then asks `/admin/api/...` and
 * shows "Unable to connect to the server". So both pages are loaded cold:
 *
 * - `/ihub/admin/apps/new` shows the Start screen, and every request it makes
 *   stays under the prefix and is answered.
 * - After an empty creation the page lands on `/ihub/admin/apps/<id>`, and a
 *   cold load of that URL shows the editor of the new app.
 *
 * No chat answer is asserted here; the app builder suite does that
 * (app-builder.spec.js). Under the default config the spec runs at the root.
 */

const BASE = (process.env.CRAWL_BASE_PATH || '').replace(/\/$/, '');
const ADMIN = { username: 'admin', password: 'password123' };
const NAME = `E2E AB Subpath ${Date.now().toString(36)}`;
const APP_ID = NAME.toLowerCase().replaceAll(' ', '-');

/**
 * Records what must not happen on a page under a prefix: a request of the app
 * that leaves the prefix, and a request the server refuses.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} origin - The origin of the deployment
 * @returns {string[]} The problems, filled while the page runs
 */
function watchRequests(page, origin) {
  const problems = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin || !BASE) return;
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) {
      // The resource type and the document say which element asked: the run in CI
      // reported a logo request outside the prefix that no local run shows.
      const from = `${request.resourceType()} from ${new URL(request.frame().url()).pathname}`;
      problems.push(
        `${request.method()} ${url.pathname} ignores the base path ${BASE} (${from}, referer ${request.headers().referer || 'none'})`
      );
      // Which element holds that address, and what the page took for its base path.
      page
        .evaluate(pathname => {
          const holders = [...document.querySelectorAll('[src],[href]')]
            .filter(el => (el.getAttribute('src') || el.getAttribute('href')) === pathname)
            .map(el => {
              const chain = [];
              for (let node = el; node && node.nodeType === 1 && chain.length < 5;) {
                chain.push(
                  node.tagName.toLowerCase() +
                    (node.id ? `#${node.id}` : '') +
                    (typeof node.className === 'string' && node.className
                      ? `.${node.className.split(' ')[0]}`
                      : '')
                );
                node = node.parentElement;
              }
              return chain.join(' < ');
            });
          return `holders: ${holders.join(' | ') || 'none in the document'}; __BASE_PATH__=${JSON.stringify(window.__BASE_PATH__)}; __SERVER_BASE_PATH__=${JSON.stringify(window.__SERVER_BASE_PATH__)}`;
        }, url.pathname)
        .then(found => problems.push(found))
        .catch(error => problems.push(`could not inspect the page: ${error.message}`));
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

test.describe('The app builder under the base path', () => {
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
    await context.request.delete(`${BASE}/api/admin/apps/${APP_ID}`);
    await context.close();
  });

  test('cold loads of "New app" and of the editor of a new app stay under the base path', async ({
    page,
    baseURL
  }) => {
    const problems = watchRequests(page, new URL(baseURL).origin);

    // A cold load of the create page.
    await page.goto(`${BASE}/admin/apps/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New app' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start empty' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
    await expect(page.getByText('Unable to connect to the server')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`${BASE}/admin/apps/new`);
    await page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the create page').toEqual([]);

    // An empty creation.
    await page.getByRole('button', { name: 'Start empty' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill(NAME);
    await page.getByRole('textbox', { name: 'Short description' }).fill('Created under a prefix.');
    await page.getByRole('textbox', { name: 'Instructions' }).fill('You answer briefly.');
    const [created] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `${BASE}/api/admin/apps`
      ),
      page.getByRole('button', { name: 'Create and test' }).click()
    ]);
    expect(created.status(), await created.text()).toBe(201);
    expect(created.request().postDataJSON().id).toBe(APP_ID);

    // The page lands in the editor, under the prefix.
    await expect(page).toHaveURL(new RegExp(`${BASE}/admin/apps/${APP_ID}$`));
    await expect(page.getByTestId('app-id')).toHaveText(APP_ID);
    await expect(page.getByRole('complementary', { name: 'Test app' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(problems, 'creating the app and landing in the editor').toEqual([]);

    // A cold load of the editor URL.
    await page.goto(`${BASE}/admin/apps/${APP_ID}`);
    await expect(page.locator('#admin-main-content h1').first()).toHaveText(NAME);
    await expect(page.getByTestId('app-id')).toHaveText(APP_ID);
    await expect(page.getByTestId('app-status')).toHaveText('Not published');
    await expect(page.locator('[id^="app-group-"][id$="-header"]')).toHaveCount(8);
    await expect(page.getByRole('link', { name: 'Apps', exact: true }).last()).toHaveAttribute(
      'href',
      `${BASE}/admin/apps`
    );
    expect(new URL(page.url()).pathname).toBe(`${BASE}/admin/apps/${APP_ID}`);
    await page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the editor').toEqual([]);
  });

  // The chat-based app builder (#3898): a cold load of the conversation view,
  // one turn and Apply, every request under the prefix. The stub model answers
  // `e2e-revise-system` with a change of the instructions (e2e-llm-stub.mjs).
  test('the conversation view loads cold, and a turn and Apply stay under the base path', async ({
    page,
    baseURL
  }) => {
    const id = `${APP_ID}-talk`;
    const original = 'You answer briefly.';
    const api = page.context().request;
    const features = await (await api.get(`${BASE}/api/admin/features`)).json();
    const featureWasOn =
      features.features?.find(feature => feature.id === 'appBuilderChat')?.enabled === true;
    const switched = await api.put(`${BASE}/api/admin/features`, {
      data: { appBuilderChat: true }
    });
    expect(switched.ok(), await switched.text()).toBeTruthy();
    try {
      const created = await api.post(`${BASE}/api/admin/apps?origin=blank`, {
        data: {
          id,
          name: { en: `${NAME} talk` },
          description: { en: 'Revised under a prefix.' },
          system: { en: original },
          color: '#4F46E5',
          icon: 'chat-bubbles',
          enabled: false
        }
      });
      expect(created.status(), await created.text()).toBe(201);

      const problems = watchRequests(page, new URL(baseURL).origin);
      await page.goto(`${BASE}/admin/apps/${id}?view=conversation`);
      const talk = page.getByTestId('conversation-panel');
      await expect(talk).toBeVisible();
      await expect(page.getByText('Unable to connect to the server')).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: 'Test app' })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(`${BASE}/admin/apps/${id}`);

      const composer = talk.getByRole('textbox', { name: 'Tell the builder what to change' });
      await composer.fill('Make it formal. e2e-revise-system');
      const [turn] = await Promise.all([
        page.waitForResponse(response => response.url().includes('/_revise')),
        composer.press('Enter')
      ]);
      expect(new URL(turn.url()).pathname).toBe(`${BASE}/api/admin/apps/_revise`);
      expect(turn.status(), await turn.text()).toBe(200);

      const card = talk.getByTestId('change-card');
      await expect(card.locator('ins')).toContainText('(e2e-revised)');
      const [saved] = await Promise.all([
        page.waitForResponse(
          response =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === `${BASE}/api/admin/apps/${id}`
        ),
        card.getByRole('button', { name: 'Apply' }).click()
      ]);
      expect(saved.status(), await saved.text()).toBe(200);
      await expect(card.getByTestId('change-applied')).toHaveText('Applied. The test restarted.');

      const stored = await (await api.get(`${BASE}/api/admin/apps/${id}`)).json();
      expect(stored.system.en).toBe(`${original}\nAddress the reader formally. (e2e-revised)`);
      await page.waitForLoadState('networkidle');
      expect(problems, 'the conversation under the base path').toEqual([]);
    } finally {
      await api.delete(`${BASE}/api/admin/apps/${id}`);
      if (!featureWasOn) {
        await api.put(`${BASE}/api/admin/features`, { data: { appBuilderChat: false } });
      }
    }
  });
});
