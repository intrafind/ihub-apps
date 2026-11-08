// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: a chat turn.
 *
 * Signs in as the default local admin (`admin` / `password123`) and chats in
 * the general Chat app. The model is the e2e stub that
 * `tests/config/e2e-server.mjs` registers: it answers
 * `E2E reply to: <message> (turn N)` and fails a message containing `e2e-fail`.
 * Against a server you started yourself, add such a model first or the tests
 * have nothing to talk to.
 */

const ADMIN = { username: 'admin', password: 'password123' };

test.describe('Chat', () => {
  test.beforeEach(async ({ page }) => {
    // The first-visit disclaimer would sit over every click.
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  // The visible copy of a text: the page also holds a hidden one for screen readers.
  const shown = (page, text) => page.getByText(text).filter({ visible: true }).first();
  // Opens the Chat app and waits until it knows its models: a message sent before
  // that is shown but never reaches the server.
  const openChat = async page => {
    const models = page.waitForResponse(
      response => response.url().includes('/api/models') && response.ok()
    );
    await page.goto('/apps/chat');
    await models;
    await page.waitForLoadState('networkidle');
  };
  const input = page => page.getByRole('textbox', { name: 'Type your message' });
  const send = page => page.getByRole('button', { name: 'Send', exact: true });

  test('lists the apps and opens the Chat app', async ({ page }) => {
    await page.goto('/apps');
    const chat = page.getByRole('link', { name: /Chat/ }).first();
    await expect(chat).toBeVisible();

    await chat.click();
    await expect(page).toHaveURL(/\/apps\/chat/);
    await expect(input(page)).toBeVisible();
    await expect(send(page)).toBeVisible();
  });

  test('sends a message and shows the streamed answer', async ({ page }) => {
    await openChat(page);
    await input(page).fill('Hello, this is a test message');
    await send(page).click();

    await expect(shown(page, 'Hello, this is a test message')).toBeVisible();
    await expect(shown(page, 'E2E reply to: Hello, this is a test message (turn 1)')).toBeVisible({
      timeout: 30_000
    });
  });

  test('keeps the conversation: the second turn is answered with the history', async ({ page }) => {
    await openChat(page);

    await input(page).fill('What is machine learning?');
    await send(page).click();
    await expect(shown(page, 'E2E reply to: What is machine learning? (turn 1)')).toBeVisible({
      timeout: 30_000
    });

    await input(page).fill('Can you give me an example?');
    await send(page).click();
    await expect(shown(page, 'E2E reply to: Can you give me an example? (turn 2)')).toBeVisible({
      timeout: 30_000
    });
    // The first exchange is still on the page.
    await expect(shown(page, 'E2E reply to: What is machine learning? (turn 1)')).toBeVisible();
  });

  test('shows an error, and keeps working, when the model fails', async ({ page }) => {
    await openChat(page);
    await input(page).fill('please e2e-fail now');
    await send(page).click();
    await expect(shown(page, /Invalid request sent to local API/)).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    await input(page).fill('Back to normal');
    await send(page).click();
    await expect(shown(page, 'E2E reply to: Back to normal')).toBeVisible({
      timeout: 30_000
    });
  });

  test('is usable on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openChat(page);
    await input(page).fill('Mobile test message');
    await send(page).click();
    await expect(shown(page, 'E2E reply to: Mobile test message')).toBeVisible({
      timeout: 30_000
    });
  });
});
