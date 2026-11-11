// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: the first-turn AI notice (EU AI Act Art. 50(1), #3325).
 *
 * Signs in as the default local admin (`admin` / `password123`), opens the Chat
 * app (answered by the e2e stub model) and checks that the notice is shown in
 * the empty chat, ends with the first message, never goes to the model, and can
 * be switched off globally. The real-model "Are you a human?" answer is a manual
 * smoke check: it is not deterministic.
 */

const ADMIN = { username: 'admin', password: 'password123' };
const NOTICE = /You are chatting with an AI system/;

test.describe('AI first-turn notice', () => {
  // One test switches the notice off platform-wide: never run them side by side.
  test.describe.configure({ mode: 'serial' });
  // ...and not in several browser projects at once: they share one server and one platform.json.
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'mutates the shared platform.json');
  });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  const input = page => page.getByRole('textbox', { name: 'Type your message' });
  const send = page => page.getByRole('button', { name: 'Send', exact: true });
  const notice = page => page.getByTestId('ai-first-turn-notice').filter({ visible: true });
  const openChat = async page => {
    const models = page.waitForResponse(
      response => response.url().includes('/api/models') && response.ok()
    );
    await page.goto('/apps/chat');
    await models;
    await page.waitForLoadState('networkidle');
  };

  const setNotice = async (page, firstTurnNotice) => {
    const current = await page.request.get('/api/admin/configs/platform');
    const platform = await current.json();
    const original = platform.aiDisclosure;
    platform.aiDisclosure = { ...original, firstTurnNotice };
    const saved = await page.request.post('/api/admin/configs/platform', { data: platform });
    expect(saved.ok()).toBeTruthy();
    return original;
  };
  const restore = async (page, original) => {
    const current = await page.request.get('/api/admin/configs/platform');
    const platform = await current.json();
    platform.aiDisclosure = original;
    await page.request.post('/api/admin/configs/platform', { data: platform });
  };

  test('shows in the empty chat, ends with the first message, never reaches the model', async ({
    page
  }) => {
    const bodies = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/api/')) {
        bodies.push(request.postData() || '');
      }
    });

    await openChat(page);
    await expect(notice(page)).toHaveText(NOTICE);

    await input(page).fill('Hello notice test');
    await send(page).click();
    await expect(
      page.getByText('E2E reply to: Hello notice test (turn 1)').filter({ visible: true }).first()
    ).toBeVisible({
      timeout: 30_000
    });
    await expect(notice(page)).toHaveCount(0);
    expect(bodies.some(body => /chatting with an AI system/.test(body))).toBe(false);
  });

  test('a global custom text replaces the built-in one; global off hides it', async ({ page }) => {
    const original = await setNotice(page, { enabled: true, text: { en: 'Custom AI notice.' } });
    try {
      await openChat(page);
      await expect(notice(page)).toHaveText('Custom AI notice.');

      await setNotice(page, { enabled: false, text: {} });
      await openChat(page);
      await expect(input(page)).toBeVisible();
      await expect(notice(page)).toHaveCount(0);
    } finally {
      await restore(page, original);
    }
  });
});
