// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: the AI-use acknowledgement (EU AI Act, #3326).
 *
 * The e2e contents switch the feature off (tests/config/e2e-contents.mjs) so the
 * other specs are not blocked by it; this spec turns it on through the admin
 * platform API and off again at the end. It changes platform-wide state, so run it on its
 * own (`--workers=1`, as CI does) rather than beside the other specs on a shared server. Signs in as the default local admin
 * (`admin` / `password123`), who has a users.json record.
 */

const ADMIN = { username: 'admin', password: 'password123' };

test.describe('AI-use acknowledgement', () => {
  // The feature is platform-wide state: never run these side by side.
  test.describe.configure({ mode: 'serial' });

  const setEnabled = async (page, enabled) => {
    const current = await page.request.get('/api/admin/configs/platform');
    const platform = await current.json();
    platform.aiAcknowledgement = { ...platform.aiAcknowledgement, enabled, enforce: true };
    const saved = await page.request.post('/api/admin/configs/platform', { data: platform });
    expect(saved.ok(), 'save the platform config').toBeTruthy();
  };

  const removeAll = async page => {
    const removed = await page.request.delete('/api/admin/ai-acknowledgements');
    expect(removed.status()).toBe(204);
  };

  // A chat POST the guard sees before it looks at the body. The body is invalid on purpose:
  // once the guard lets the request through, validation answers 400, so a 428 versus a 400 tells
  // "asked to confirm" from "confirmed" without sending a message.
  const chatPost = page =>
    page.request.post('/api/apps/chat/chat/chat-e2e-ack', { data: { messages: null } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
    await setEnabled(page, true);
    await removeAll(page);
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    if (login.ok()) await setEnabled(page, false);
    await context.close();
  });

  const input = page => page.getByRole('textbox', { name: 'Type your message' });
  const send = page => page.getByRole('button', { name: 'Send', exact: true });
  const openChat = async page => {
    const models = page.waitForResponse(
      response => response.url().includes('/api/models') && response.ok()
    );
    await page.goto('/apps/chat');
    await models;
    await page.waitForLoadState('networkidle');
  };

  test('a chat POST without acknowledgement answers 428 and nothing is stored', async ({
    page
  }) => {
    const res = await chatPost(page);
    expect(res.status()).toBe(428);
    expect(res.headers()['content-type']).toMatch(/application\/problem\+json/);
    expect((await res.json()).code).toBe('AI_ACKNOWLEDGEMENT_REQUIRED');
  });

  test('the dialog blocks the first message; Confirm and send delivers it', async ({ page }) => {
    await openChat(page);
    await input(page).fill('Hello acknowledgement');
    await send(page).click();

    const dialog = page.getByRole('dialog', { name: 'Confirm your use of AI' });
    await expect(dialog).toBeVisible();
    // Nothing was sent: the draft is still in the composer.
    await expect(input(page)).toHaveValue('Hello acknowledgement');

    await dialog.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(
      page
        .getByText('E2E reply to: Hello acknowledgement (turn 1)')
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toHaveCount(0);

    // Acknowledged: the same request is accepted by the guard now (it fails later, on the body).
    const after = await chatPost(page);
    expect(after.status()).toBe(400);
  });

  test('Cancel keeps the draft and sends nothing', async ({ page }) => {
    await openChat(page);
    await input(page).fill('Not yet');
    await send(page).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your use of AI' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(input(page)).toHaveValue('Not yet');
    await expect(page.getByTestId('ai-ack-note').filter({ visible: true }).first()).toBeVisible();
  });

  test('Request again asks everyone once more; Remove all does too; the CSV lists the user', async ({
    page
  }) => {
    const notice = await (await page.request.get('/api/ai-acknowledgements/me?language=en')).json();
    expect(notice.acknowledged).toBe(false);
    const confirmed = await page.request.post('/api/ai-acknowledgements/me', {
      data: {
        version: notice.requiredVersion,
        textHash: notice.textHash,
        language: notice.language
      }
    });
    expect(confirmed.status()).toBe(201);
    expect((await chatPost(page)).status()).toBe(400);

    const csv = await page.request.get(
      '/api/admin/ai-acknowledgements/_export?status=acknowledged'
    );
    expect(csv.ok()).toBeTruthy();
    expect(await csv.text()).toContain('admin');

    const again = await page.request.post('/api/admin/ai-acknowledgements/_request-again');
    expect(again.ok()).toBeTruthy();
    expect((await again.json()).requiredVersion).toBe(notice.requiredVersion + 1);
    expect((await chatPost(page)).status()).toBe(428);

    // Confirm the new version, then remove every confirmation.
    const next = await (await page.request.get('/api/ai-acknowledgements/me?language=en')).json();
    await page.request.post('/api/ai-acknowledgements/me', {
      data: { version: next.requiredVersion, textHash: next.textHash, language: next.language }
    });
    expect((await chatPost(page)).status()).toBe(400);
    await removeAll(page);
    expect((await chatPost(page)).status()).toBe(428);
  });

  test('the users page shows the AI acknowledgement column', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page.getByRole('columnheader', { name: 'AI acknowledgement' })).toBeVisible();
    await expect(page.getByText('Not acknowledged').first()).toBeVisible();
  });
});
