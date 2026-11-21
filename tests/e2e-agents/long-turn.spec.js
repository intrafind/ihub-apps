// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  openApp,
  sendButton,
  sendMessage,
  serverStatus,
  shown,
  signInPage,
  stub,
  transcript,
  unique
} from './helpers.mjs';
import { OVERLAY_NAME, USER } from '../config/agents-scenario.mjs';

/**
 * An answer that takes longer than a timeout of the browser is written to its end
 * (#2712). Neither timeout stops the turn on the server.
 *
 * Two limits exist in the browser, one per way a chat turn travels:
 *
 * - **GET, then POST** (the seeded settings): the request that sends the message
 *   is answered when the turn ends, and gives up after five minutes. The reply is
 *   lost, not the turn: the page asks whether the turn is running and keeps
 *   reading the stream. A development build lets a test shorten that timeout
 *   (`window.__ihubStreamTimeoutMs`, `client/src/api/endpoints/apps.js`), so the
 *   first test below loses the reply after two seconds instead of five minutes.
 * - **One POST that streams** (`chatPostStream`): no total timeout, only an idle
 *   limit of 60 seconds without a byte. The second test runs past it.
 *
 * Both tests run in both positions (`@matrix`): the second one also takes the
 * GET stream past its status poll, which runs every 60 seconds.
 */

/** What the test sets the timeout of the chat POST to. */
const CLIENT_TIMEOUT_MS = 2000;

/**
 * The slow answer of the second test: one word every `everyMs`, 70 seconds in
 * all. Longer than the idle limit of a turn's POST stream
 * (`TURN_IDLE_TIMEOUT_MS`, 60 s) and than the interval of the GET stream's
 * status poll; `tests/unit/client/chat-post-stream.test.jsx` keeps it so.
 */
const SLOW = { everyMs: 5000, words: 14 };

/** Texts the chat page writes under an answer whose request or stream failed. */
const FAILURE_TEXT =
  /Request timed out|Connection timeout|connection was lost|Streaming connection failed|Failed to generate response|An error occurred/i;

/** The button that stops the answer: there while the page is waiting for the turn. */
const stopButton = page => page.getByRole('button', { name: 'Cancel', exact: true });

/**
 * Record what the page sends about a chat of `appId`. Call it before the message
 * is sent. Nothing is intercepted.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} appId
 * @returns {{
 *   turns: () => Array<{method: string, type: string|null, failed: boolean}>,
 *   statusChecks: () => Array<Object|null>,
 *   stops: () => string[],
 *   chatId: () => string|null
 * }} `turns`: the requests to the chat URL itself, oldest first, with the content
 *   type of the response (`null` without one) and whether the browser gave the
 *   request up. `statusChecks`: the bodies the status route answered with (`null`
 *   for a failed one). `stops`: the URLs of the stop requests.
 */
function watchTurn(page, appId) {
  const turns = [];
  const statuses = [];
  const stops = [];
  const chat = new RegExp(`/api/apps/${appId}/chat/([^/]+)(/status|/stop)?$`);
  const partOf = request => chat.exec(new URL(request.url()).pathname);

  page.on('request', request => {
    const match = partOf(request);
    if (!match) return;
    if (match[2] === '/stop') stops.push(`${request.method()} ${request.url()}`);
    else if (!match[2]) {
      turns.push({ request, id: match[1], method: request.method(), type: null, failed: false });
    }
  });
  page.on('requestfailed', request => {
    const entry = turns.find(item => item.request === request);
    if (entry) entry.failed = true;
    if (partOf(request)?.[2] === '/status') statuses.push(null);
  });
  page.on('response', response => {
    const match = partOf(response.request());
    if (!match) return;
    if (match[2] === '/status') {
      // Read in the background: the test polls the list.
      response
        .json()
        .then(body => statuses.push(body))
        .catch(() => statuses.push(null));
      return;
    }
    const entry = turns.find(item => item.request === response.request());
    if (entry) entry.type = (response.headers()['content-type'] || '').split(';')[0].trim();
  });

  return {
    turns: () => turns.map(({ method, type, failed }) => ({ method, type, failed })),
    statusChecks: () => [...statuses],
    stops: () => [...stops],
    chatId: () => turns[0]?.id ?? null
  };
}

/** The chat page of the app `chat`, signed in, with the shortened POST timeout. */
async function openChat(page) {
  await page.addInitScript(timeoutMs => {
    window.__ihubStreamTimeoutMs = timeoutMs;
  }, CLIENT_TIMEOUT_MS);
  await signInPage(page, USER);
  await openApp(page, 'chat');
  // Set before any script of the page ran. Whether the build reads it shows in
  // the first test: the POST is given up after two seconds, not after five minutes.
  expect(await page.evaluate(() => window.__ihubStreamTimeoutMs)).toBe(CLIENT_TIMEOUT_MS);
}

/**
 * What must hold once the answer is complete, whichever limit the turn passed:
 * the page shows no failure, nobody told the server to stop, the model was asked
 * once and its call was not cut off, and the server stored the answer.
 */
async function expectUndisturbedTurn(page, turn, { marker, answer, abortedBefore }) {
  // The turn is over for the page too: the button sends again.
  await expect(sendButton(page)).toBeVisible({ timeout: 15_000 });
  await expect(transcript(page).getByText(FAILURE_TEXT)).toHaveCount(0);

  expect(turn.stops(), 'requests to the stop route').toEqual([]);
  expect((await stub.stats()).aborted, 'model calls the server cut off').toBe(abortedBefore);
  // Asked once: the turn was neither sent a second time nor started again.
  const asked = await stub.requests(marker);
  expect(asked.filter(body => body.stream === true)).toHaveLength(1);

  // What the server kept is the whole answer, without an error.
  const stored = await page.request.get(`/api/chats/${turn.chatId()}`);
  expect(stored.status(), await stored.text()).toBe(200);
  const messages = (await stored.json()).messages;
  expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(messages[1].content).toBe(answer);
  expect(messages[1].error ?? null).toBeNull();
}

test.describe('A turn that outlasts a timeout of the browser', () => {
  test.afterEach(async () => {
    // A failed test must not leave a model call waiting for the next one.
    await stub.releaseAll();
  });

  test(
    'an answer that takes longer than the request that sent the message is completed',
    { tag: ['@gate', '@matrix'] },
    async ({ page }) => {
      const { overlay } = await serverStatus();
      const postStream = overlay.features?.chatPostStream === true;
      await openChat(page);
      const turn = watchTurn(page, 'chat');
      const abortedBefore = (await stub.stats()).aborted;
      const key = `long-${crypto.randomUUID().slice(0, 8)}`;

      // The model takes the request and says nothing until it is released.
      await sendMessage(page, `e2e-hang:${key}`);
      await expect
        .poll(async () => (await stub.stats()).hanging, {
          message: 'the model stub has the request',
          timeout: 15_000
        })
        .toContain(key);

      if (postStream) {
        // The message went out on the request that streams the answer: nothing
        // waits for a reply, so the shortened timeout has nothing to cut.
        await page.waitForTimeout(CLIENT_TIMEOUT_MS + 1500);
      } else {
        // The request that sent the message gives up while the turn is running.
        await expect
          .poll(() => turn.turns().at(-1), {
            message: `the request that sent the message, with the settings "${OVERLAY_NAME}"`,
            timeout: 15_000
          })
          .toEqual({ method: 'POST', type: null, failed: true });
        // The page then asks the server whether the turn is running. A page
        // that took the lost reply for a failure would write that instead.
        await expect
          .poll(
            async () =>
              turn.statusChecks().length > 0 ||
              (await transcript(page).getByText(FAILURE_TEXT).count()) > 0,
            { message: 'the page reacts to the lost reply', timeout: 15_000 }
          )
          .toBe(true);
      }

      // No failure is shown, and the page is still waiting for the answer.
      await expect(
        transcript(page).getByText(FAILURE_TEXT),
        'a lost reply is not a failure'
      ).toHaveCount(0);
      await expect(stopButton(page)).toBeVisible();
      expect((await stub.stats()).hanging).toContain(key);
      if (postStream) {
        expect(turn.turns()).toEqual([
          { method: 'POST', type: 'text/event-stream', failed: false }
        ]);
        expect(turn.statusChecks()).toEqual([]);
      } else {
        // The server said the turn is being worked on, and the stream stayed open.
        expect(turn.statusChecks()).toEqual([
          expect.objectContaining({ active: true, processing: true })
        ]);
        expect(turn.turns()).toEqual([
          { method: 'GET', type: 'text/event-stream', failed: false },
          { method: 'POST', type: null, failed: true }
        ]);
      }

      await stub.release(key);
      await expect(shown(page, `E2E released: ${key}`)).toBeVisible({ timeout: 30_000 });

      await expectUndisturbedTurn(page, turn, {
        marker: `e2e-hang:${key}`,
        answer: `E2E released: ${key}`,
        abortedBefore
      });
      // The stream that was open when the reply was lost carried the answer.
      expect(turn.turns()).toHaveLength(postStream ? 1 : 2);
    }
  );

  test(
    'an answer that takes longer than the idle limit of its stream is completed',
    { tag: ['@slow', '@matrix'] },
    async ({ page }) => {
      const totalMs = SLOW.everyMs * SLOW.words;
      test.setTimeout(totalMs + 90_000);
      const { overlay } = await serverStatus();
      const postStream = overlay.features?.chatPostStream === true;
      await openChat(page);
      const turn = watchTurn(page, 'chat');
      const abortedBefore = (await stub.stats()).aborted;
      const message = unique(`e2e-slow:${SLOW.everyMs}:${SLOW.words}`);
      const words = Array.from({ length: SLOW.words }, (_, index) => `slow-${index + 1}`);

      const startedAt = Date.now();
      await sendMessage(page, message);
      await expect(shown(page, /slow-1 slow-2/)).toBeVisible({ timeout: 30_000 });

      // The first word that arrives after the 60 seconds: the stream it comes on
      // is the one the turn began on, still open.
      const pastTheLimit = words[Math.ceil(60_000 / SLOW.everyMs)];
      await expect(shown(page, new RegExp(`${pastTheLimit}\\b`))).toBeVisible({
        timeout: totalMs + 30_000
      });
      expect(Date.now() - startedAt, 'how long the turn has taken').toBeGreaterThan(60_000);
      await expect(page.getByText(words.at(-1)), 'the answer is still being written').toHaveCount(
        0
      );
      if (postStream) {
        // One connection from the first word on: the idle limit did not cut it,
        // so the page never had to attach to the turn again.
        expect(turn.turns()).toEqual([
          { method: 'POST', type: 'text/event-stream', failed: false }
        ]);
        expect(turn.statusChecks()).toEqual([]);
      } else {
        // The reply was lost after two seconds; the stream opened before it is
        // still the one that carries the answer, past its status poll at 60 seconds.
        expect(turn.turns()).toEqual([
          { method: 'GET', type: 'text/event-stream', failed: false },
          { method: 'POST', type: null, failed: true }
        ]);
        const checks = turn.statusChecks();
        expect(checks.length, 'the lost reply and the poll at 60 seconds').toBeGreaterThan(1);
        for (const check of checks) {
          expect(check).toEqual(expect.objectContaining({ active: true, processing: true }));
        }
      }

      await expect(shown(page, words.join(' '))).toBeVisible({ timeout: 60_000 });
      await expectUndisturbedTurn(page, turn, {
        marker: message,
        answer: words.join(' '),
        abortedBefore
      });
      // No request to the chat was added: the turn was not attached to again.
      expect(turn.turns()).toHaveLength(postStream ? 1 : 2);
    }
  );
});
