// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  chatTurn,
  dismissDisclaimer,
  openApp,
  restartServer,
  sendMessage,
  serverStatus,
  shown,
  signedIn,
  signInPage,
  stub,
  transcript,
  unique,
  watchChatRequests
} from './helpers.mjs';
import { ADMIN, MODELS, OTHER, OVERLAY_NAME, TOOLS_APP, USER } from '../config/agents-scenario.mjs';

/**
 * The smoke test of the agents suite: the stack is up, a person can sign in, an
 * answer streams into the page while the model is still writing, a tool call shows
 * in the answer, the suite's two users exist, and the server comes back on the
 * same contents after a restart.
 *
 * Every later spec builds on these: a failure here means the stack or the model
 * stub is broken, not the feature a spec is about.
 */

test.describe('Agents suite smoke', () => {
  test.afterEach(async () => {
    // A failed test must not leave a model call waiting for the next one.
    await stub.releaseAll();
  });

  test('the admin signs in through the sign-in form', { tag: '@gate' }, async ({ page }) => {
    await dismissDisclaimer(page);
    await page.goto('/apps');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.getByRole('textbox', { name: 'Username or Email' }).fill(ADMIN.username);
    await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN.password);
    await page.getByRole('textbox', { name: 'Password' }).press('Enter');

    await expect(page.getByRole('button', { name: /User menu: .*Demo Administrator/ })).toBeVisible(
      { timeout: 30_000 }
    );
    // Signed in, the admin sees the apps an anonymous visitor does not.
    await expect(page.getByRole('link', { name: 'E2E tools' }).first()).toBeVisible();
  });

  // Also in the transport matrix: the answer must stream the same way on every
  // way the browser can receive it. Which way that is, the test reads off the
  // page's own requests: a matrix run whose overlay changed nothing would
  // otherwise pass as a second copy of the seeded run.
  test('a slow answer appears word by word', { tag: ['@gate', '@matrix'] }, async ({ page }) => {
    const { overlay } = await serverStatus();
    await signInPage(page, ADMIN);
    await openApp(page, 'chat');
    const chatRequests = watchChatRequests(page, 'chat');

    // Eight words, one every 500 ms: the last one is 3.5 s behind the first.
    await sendMessage(page, 'e2e-slow:500:8');
    await expect(shown(page, /slow-1 slow-2/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('slow-8'), 'the answer is still being written').toHaveCount(0);

    await expect(
      shown(page, 'slow-1 slow-2 slow-3 slow-4 slow-5 slow-6 slow-7 slow-8')
    ).toBeVisible({ timeout: 30_000 });

    // The answer can be complete on the stream before the request that sent the
    // message has its response, so the list is read until it is what is expected.
    await expect
      .poll(chatRequests, {
        message: `the connections of a chat turn with the settings "${OVERLAY_NAME}"`,
        timeout: 10_000
      })
      .toEqual(
        overlay.features?.chatPostStream === true
          ? // One connection: the request that sends the message carries the answer.
            [{ method: 'POST', type: 'text/event-stream' }]
          : // Two: the stream is opened first, the message is sent once it is connected.
            [
              { method: 'GET', type: 'text/event-stream' },
              { method: 'POST', type: 'application/json' }
            ]
      );
  });

  test('a tool call shows as a row of the answer', { tag: '@gate' }, async ({ page }) => {
    await signInPage(page, ADMIN);
    await openApp(page, TOOLS_APP);

    const message = unique('e2e-tool:list_scheduled_tasks');
    await sendMessage(page, message);
    // The stub answers with what the tool returned: the call really ran.
    await expect(shown(page, /E2E tool result seen: \{"count":/)).toBeVisible({ timeout: 30_000 });

    await transcript(page).getByRole('button', { name: '1 call' }).click();
    await expect(
      transcript(page).getByRole('listitem').filter({ hasText: 'List scheduled tasks' })
    ).toBeVisible();

    // What reached the model: the call, then the request that carries its result.
    const requests = await stub.requests(message);
    expect(requests.map(body => body.messages.at(-1).role)).toEqual(['user', 'tool']);
    expect(requests[0].tools.map(tool => tool.function.name)).toContain('list_scheduled_tasks');
  });

  test(
    'the two regular users sign in and do not see each other’s chats',
    { tag: '@gate' },
    async () => {
      const user = await signedIn(USER);
      const other = await signedIn(OTHER);

      const turn = await chatTurn(user, 'chat', 'Hello from e2e-user');
      expect(turn.status, turn.text).toBe(200);
      expect(turn.answer).toBe('E2E reply to: Hello from e2e-user (turn 1)');

      expect((await user.get(`/api/chats/${turn.chatId}`)).status()).toBe(200);
      expect((await other.get(`/api/chats/${turn.chatId}`)).status()).toBe(404);
      // Regular users: no admin API.
      expect((await user.get('/api/admin/apps')).status()).toBe(403);
      expect((await other.get('/api/admin/apps')).status()).toBe(403);

      await user.dispose();
      await other.dispose();
    }
  );

  test('the server restarts on the same contents', { tag: '@gate' }, async () => {
    const user = await signedIn(USER);
    const message = unique('Remember me over the restart');
    const turn = await chatTurn(user, 'chat', message, { modelId: MODELS.default });
    expect(turn.status, turn.text).toBe(200);

    const before = await restartServer();
    const after = await restartServer({ signal: 'SIGKILL' });
    expect(after.starts).toBe(before.starts + 1);
    expect(after.running).toBe(true);

    // The same session, the same chat: nothing was seeded again.
    const chat = await user.get(`/api/chats/${turn.chatId}`);
    expect(chat.status()).toBe(200);
    expect((await chat.json()).messages.map(entry => entry.content)).toEqual([
      message,
      `E2E reply to: ${message} (turn 1)`
    ]);
    // The model stub lives outside the server: it still knows the request.
    expect(await stub.requests(message)).toHaveLength(1);

    await user.dispose();
  });
});
