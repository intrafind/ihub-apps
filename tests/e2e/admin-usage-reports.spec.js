// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: the admin usage reports.
 *
 * Signs in as the default local admin (`admin` / `password123`) that a fresh
 * `contents/` ships with. Works on a server without any usage yet: every view
 * must render its empty state, and the range, tab and breakdown dimension are
 * kept in the URL.
 */

const ADMIN = { username: 'admin', password: 'password123' };

async function signIn(request) {
  const response = await request.post('/api/auth/local/login', { data: ADMIN });
  expect(response.ok()).toBeTruthy();
}

test.describe('Admin usage reports', () => {
  test.beforeEach(async ({ page }) => {
    // The first-visit disclaimer would sit over every click.
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    await signIn(page.request);
  });

  test('the report API answers for every range and refuses bad input', async ({ page }) => {
    for (const range of ['today', '24h', '7d', '30d', '90d', '12m']) {
      const response = await page.request.get(`/api/admin/usage/summary?range=${range}`);
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.range).toBe(range);
      expect(body.totals).toHaveProperty('requests');
      expect(body.previous).toHaveProperty('requests');
      expect(Array.isArray(body.series)).toBeTruthy();
    }
    const breakdown = await page.request.get('/api/admin/usage/breakdown?range=7d&dimension=group');
    expect(breakdown.ok()).toBeTruthy();
    expect((await breakdown.json()).dimension).toBe('group');

    const calls = await page.request.get('/api/admin/usage/calls?range=7d&limit=5');
    expect(calls.ok()).toBeTruthy();
    expect(Array.isArray((await calls.json()).items)).toBeTruthy();

    const bad = await page.request.get('/api/admin/usage/summary?range=forever');
    expect(bad.status()).toBe(400);

    // The lifetime counters are gone (clean break).
    const old = await page.request.get('/api/admin/usage');
    expect(old.ok()).toBeFalsy();
  });

  test('anonymous callers cannot read the reports', async ({ playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    const response = await anonymous.get('/api/admin/usage/summary?range=7d');
    expect(response.ok()).toBeFalsy();
    await anonymous.dispose();
  });

  test('overview, breakdown, reliability and requests render and keep state in the URL', async ({
    page
  }) => {
    await page.goto('/admin/usage');
    await expect(page.getByRole('heading', { name: 'Usage Reports' })).toBeVisible();

    // Overview: KPI cards and the chart panel (or its empty state).
    await expect(page.getByTestId('usage-kpis')).toBeVisible();
    await expect(page.getByTestId('usage-kpi-requests')).toBeVisible();
    await expect(page.getByTestId('usage-over-time')).toBeVisible();

    // The range is part of the URL.
    await page.getByRole('button', { name: '30 days' }).click();
    await expect(page).toHaveURL(/range=30d/);
    await page.getByRole('button', { name: 'Today' }).click();
    await expect(page).toHaveURL(/range=today/);
    await expect(page.getByLabel('Auto-refresh')).toBeVisible();

    // Breakdown by group.
    await page.getByRole('tab', { name: 'Breakdown' }).click();
    await expect(page).toHaveURL(/tab=breakdown/);
    await expect(page.getByTestId('usage-breakdown')).toBeVisible();
    const dimension = page.getByRole('group', { name: 'Dimension' });
    await dimension.getByRole('button', { name: 'Group', exact: true }).click();
    await expect(page).toHaveURL(/dim=group/);

    // Reliability and the request log.
    await page.getByRole('tab', { name: 'Reliability' }).click();
    await expect(page.getByTestId('usage-reliability')).toBeVisible();
    await page.getByRole('tab', { name: 'Requests' }).click();
    await expect(page.getByTestId('usage-request-log')).toBeVisible();
    await expect(page.getByLabel('Outcome')).toBeVisible();

    // Limits & quotas, with the near-limit list.
    await page.getByRole('tab', { name: 'Limits & quotas' }).click();
    await expect(page.getByTestId('usage-near-limit')).toBeVisible();

    // A reload keeps the view.
    await page.goto('/admin/usage?tab=breakdown&range=7d&dim=model');
    await expect(page.getByTestId('usage-breakdown')).toBeVisible();
    await expect(
      page
        .getByRole('group', { name: 'Dimension' })
        .getByRole('button', { name: 'Model', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
