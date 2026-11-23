// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: a config page that failed to load offers no Save (ID-B1, IN-B1,
 * IN-B6, OB-B1, OB-B2, PL-B3, CU-B5 / UX-N4).
 *
 * For each page, the GETs that feed its Save are answered with a 429
 * problem+json (route interception — never a real 429, which would leak into
 * other specs, and never `abort`, which the API client retries once). Then:
 * - the error panel with Retry is shown, and no enabled Save;
 * - clicking every visible button in the main content sends no write
 *   (POST/PUT/PATCH/DELETE) to /api/admin — writes are also intercepted and
 *   answered without reaching the server, so a regression cannot change the
 *   instance;
 * - once the GETs answer normally again, Retry (in place, no reload) brings
 *   the form back.
 *
 * Signs in as the default local admin (`admin` / `password123`). Read-only for
 * the instance: no request that changes anything reaches the server.
 */

const ADMIN = { username: 'admin', password: 'password123' };

/** Pathname ends with `/api/admin<suffix>` (works at the root and under a subpath). */
const adminGet = suffix => url => new URL(url).pathname.endsWith(`/api/admin${suffix}`);

/**
 * Each page and the GETs whose failure must gate it. `ready` (optional) checks
 * the loaded page; by default the panel is gone and a form control is visible.
 */
const PAGES = [
  { name: 'Authentication', path: '/admin/auth', gets: ['/configs/platform'] },
  { name: 'MCP gateway', path: '/admin/mcp/gateway', gets: ['/configs/platform'] },
  { name: 'Telemetry', path: '/admin/telemetry', gets: ['/configs/platform'] },
  {
    name: 'Logging (all GETs)',
    path: '/admin/logging',
    gets: ['/logging/config', '/configs/platform', '/audit-log/settings']
  },
  { name: 'Logging (audit settings only)', path: '/admin/logging', gets: ['/audit-log/settings'] },
  {
    name: 'Security cards',
    path: '/admin/security',
    gets: [
      '/ssl/config',
      '/ssrf/config',
      '/cors/config',
      '/proxy/config',
      '/rate-limits',
      '/configs/platform'
    ]
  },
  { name: 'Artifacts', path: '/admin/artifacts', gets: ['/artifacts/config'] },
  { name: 'UI customization', path: '/admin/ui', gets: ['/ui/config'] },
  {
    name: 'Office integration',
    path: '/admin/office-integration',
    gets: ['/office-integration/status']
  },
  {
    name: 'Browser extension',
    path: '/admin/browser-extension',
    gets: ['/browser-extension/status']
  },
  {
    name: 'Copilot agent',
    path: '/admin/copilot-agent',
    gets: ['/copilot-agent/status'],
    // A fresh install has the integration off: the loaded page is its status card.
    ready: main => main.getByRole('button', { name: /^Enable$/ })
  },
  { name: 'Nextcloud embed', path: '/admin/nextcloud-embed', gets: ['/nextcloud-embed/status'] },
  { name: 'iHub in another site', path: '/admin/embed-auth', gets: ['/embed-auth/config'] },
  { name: 'Voice input', path: '/admin/voice-input', gets: ['/configs/platform'] },
  { name: 'OAuth server', path: '/admin/oauth/server', gets: ['/configs/platform'] },
  { name: 'Feedback settings', path: '/admin/feedback', gets: ['/configs/platform'] }
];

const RATE_LIMITED = {
  status: 429,
  contentType: 'application/problem+json',
  // Short, so the Retry countdown is over by the time the test clicks it.
  headers: { 'Retry-After': '1' },
  body: JSON.stringify({
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Too many requests (simulated by the test)',
    code: 'RATE_LIMITED'
  })
};

test.describe('Admin config pages after a failed load', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  for (const target of PAGES) {
    test(`${target.name}: error with Retry, no Save, no write; Retry loads the form`, async ({
      page
    }) => {
      // Record — and swallow — every write to the admin API.
      const writes = [];
      await page.route(
        url => new URL(url).pathname.includes('/api/admin/'),
        async route => {
          const request = route.request();
          if (request.method() === 'GET') return route.fallback();
          writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
          return route.fulfill({ status: 204 });
        }
      );

      // The page's own GETs fail with a 429 until unrouted.
      const failing = target.gets.map(suffix => adminGet(suffix));
      const failGet = route =>
        route.request().method() === 'GET' ? route.fulfill(RATE_LIMITED) : route.fallback();
      for (const matcher of failing) await page.route(matcher, failGet);

      await page.goto(target.path);
      const main = page.locator('main');

      const panels = main.getByTestId('admin-load-error');
      await expect(panels.first()).toBeVisible();
      await expect(panels.first()).toContainText('Nothing was changed.');
      await expect(main.getByRole('button', { name: /Retry/ }).first()).toBeVisible();

      // No enabled Save anywhere in the page content.
      const saves = main.getByRole('button', { name: /save/i });
      for (const save of await saves.all()) {
        if (await save.isVisible()) await expect(save).toBeDisabled();
      }

      // Click every visible, enabled button in the content (Retry included: it
      // only re-runs the failing GET) and stay on the page.
      const startUrl = page.url();
      const buttons = await main.getByRole('button').all();
      for (const button of buttons) {
        if (!(await button.isVisible().catch(() => false))) continue;
        if (!(await button.isEnabled().catch(() => false))) continue;
        await button.click({ timeout: 2_000 }).catch(() => {});
        if (page.url() !== startUrl) await page.goto(target.path);
      }
      expect(writes, 'no write may leave a page that failed to load').toEqual([]);

      // Start over from the failed state (a click may have switched a tab).
      await page.goto(target.path);
      await expect(panels.first()).toBeVisible();

      // The GETs answer normally again: Retry loads the form in place.
      for (const matcher of failing) await page.unroute(matcher, failGet);
      const navigations = [];
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });

      for (let i = 0; i < 10 && (await panels.count()) > 0; i += 1) {
        const retry = main.getByRole('button', { name: /^Retry$/ }).first();
        await expect(retry).toBeEnabled({ timeout: 5_000 });
        await retry.click();
        await page.waitForTimeout(300);
      }

      await expect(panels).toHaveCount(0);
      // The form (or the page's first control) is back.
      await expect(
        target.ready
          ? target.ready(main)
          : main
              .locator(
                'input:visible, select:visible, textarea:visible, [role="switch"]:visible, [role="tablist"]:visible'
              )
              .first()
      ).toBeVisible();
      expect(navigations, 'Retry re-runs the load in place, without a page reload').toEqual([]);
      expect(writes).toEqual([]);
    });
  }
});
