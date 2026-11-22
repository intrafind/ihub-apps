// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  composer,
  openApp,
  restartServer,
  serverStatus,
  shown,
  signedIn,
  signInPage,
  stub,
  transcript
} from './helpers.mjs';
import { ADMIN, OTHER, TOOLS_APP, USER } from '../config/agents-scenario.mjs';

/**
 * A message while iHub is working (#3191), in a real browser against the real
 * server, with the feature `steering` on:
 *
 * - the composer stays open during a run; Stop and Send are two controls, and
 *   Enter never stops the run;
 * - a message typed during the run waits as an item of the strip, is read at the
 *   next step and appears in the answer, in the same place after a reload;
 * - "Send after this answer" becomes the next turn and leaves the running answer
 *   as it is;
 * - the strip works by keyboard with four items at 320 px in German, and a
 *   removed item is never read;
 * - only the chat's owner sends into the run;
 * - the states pass axe (WCAG 2.2 AA, critical and serious).
 *
 * The run is held by the model stub: `e2e-hang:<key>` holds the model call, and
 * `hold-then-call` holds a tool call (so the answer has a next step that reads the
 * message). A message is sent only after the hang reached the stub: one sent
 * before the first model call is read at that step.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** The chat page renders a list and a composer for narrow and for wide screens; one is hidden. */
const visible = locator => locator.filter({ visible: true });
const strip = page => visible(page.getByTestId('pending-work-strip'));
const pendingItems = page => strip(page).getByTestId('pending-item');
const applied = page => visible(page.getByTestId('applied-message'));
const announcer = page => page.getByTestId('announcer');

/** A text of this test only. */
const unique = text => `${text} ${crypto.randomUUID().slice(0, 8)}`;

/** Wait until the stub holds the model call of `key`. */
async function waitForHang(key) {
  await expect
    .poll(async () => (await stub.stats()).hanging, {
      message: `the hang ${key} reaches the model stub`,
      timeout: 20_000
    })
    .toContain(key);
}

/** The marker of a tool call the stub holds until `stub.release(key)`. */
const heldCall = (key, tool, args) =>
  `e2e-script:hold-then-call hold=${key} tool=${tool} args=${JSON.stringify(args)}`;

/** Send `text` from the composer and wait until its run is held at the stub. */
async function startHeldTurn(page, text, key) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitForHang(key);
  // The composer is in its running state once the server said this person may send.
  await expect(visible(page.getByRole('button', { name: 'Stop answer' }))).toBeVisible();
}

/** The composer's text field in German. */
const composerDe = page => page.getByRole('textbox', { name: 'Nachricht eingeben' });

/** Type into the open composer and press Enter. */
async function typeAndEnter(page, text, input = composer(page)) {
  await input.fill(text);
  await input.press('Enter');
}

/** Scan the page with axe; fail on critical and serious violations. */
async function expectAccessible(page, label) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations.filter(v => ['critical', 'serious'].includes(v.impact));
  expect(
    blocking.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`),
    `${label}: critical or serious axe violations`
  ).toEqual([]);
}

test.describe('A message while iHub is working', () => {
  let seeded;

  test.beforeAll(async () => {
    seeded = (await serverStatus()).overlay || {};
    await restartServer({
      overlay: { ...seeded, features: { ...seeded.features, steering: true } }
    });
  });

  test.afterAll(async () => {
    await restartServer({ overlay: seeded });
  });

  test.afterEach(async () => {
    // A failed test must not leave a model call waiting for the next one.
    await stub.releaseAll();
  });

  test(
    'a message typed during a run is read at the next step, without stopping the run, and stays in place after a reload',
    { tag: ['@gate', '@matrix'] },
    async ({ page }) => {
      await signInPage(page, USER);
      await openApp(page, TOOLS_APP);
      const key = `steer-${crypto.randomUUID().slice(0, 8)}`;
      const question = heldCall(key, 'e2e_counter_read', { key });
      await startHeldTurn(page, question, key);

      // Two controls; the field is open and keeps the focus.
      const input = composer(page);
      await expect(input).toBeEditable();
      await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      const stats = await stub.stats();

      // An empty Enter and a press on Send with nothing typed stop nothing.
      await input.focus();
      await input.press('Enter');
      await expect(visible(page.getByRole('button', { name: 'Send', exact: true }))).toBeDisabled();
      await expect(visible(page.getByRole('button', { name: 'More ways to send' }))).toBeDisabled();

      const message = unique('Use the 2025 numbers');
      await typeAndEnter(page, message);
      await expect(pendingItems(page)).toHaveCount(1);
      await expect(pendingItems(page).first()).toContainText(
        `Will be read at the next step: ${message}`
      );
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('');
      await expect(announcer(page)).toHaveText('Your message will be read at the next step');
      // Enter did not stop the run: the model call still waits, nothing was aborted.
      expect((await stub.stats()).hanging).toContain(key);
      expect((await stub.stats()).aborted).toBe(stats.aborted);
      await expectAccessible(page, 'composer while iHub is working, one message waiting');

      // The tool call comes, the next step reads the message, the answer goes on.
      await stub.release(key);
      const reply = shown(
        page,
        `Mid-run instruction from the person running this task: ${message}`
      );
      await expect(reply).toBeVisible({ timeout: 30_000 });
      await expect(pendingItems(page)).toHaveCount(0);
      await expect(applied(page)).toHaveCount(1);
      await expect(applied(page).first()).toContainText(message);
      await expect(applied(page).first()).toContainText('Sent while iHub was working');
      await expect(visible(page.getByRole('button', { name: 'Stop answer' }))).toHaveCount(0);

      // In the answer, below its question and above its text, live and after a reload.
      const placed = async () => {
        const bubble = await applied(page).first().elementHandle();
        const text = await reply.elementHandle();
        const asked = await shown(page, question).elementHandle();
        return page.evaluate(
          ([b, t, q]) =>
            Boolean(q.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            Boolean(b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING),
          [bubble, text, asked]
        );
      };
      expect(await placed()).toBe(true);
      await expect(page).toHaveURL(/\/c\//);
      await page.reload();
      await expect(reply).toBeVisible({ timeout: 15_000 });
      await expect(applied(page)).toHaveCount(1);
      await expect(applied(page).first()).toContainText(message);
      expect(await placed()).toBe(true);
    }
  );

  test(
    '"Send after this answer" becomes the next turn and leaves the running answer as it is',
    { tag: ['@gate', '@matrix'] },
    async ({ page }) => {
      await signInPage(page, USER);
      await openApp(page, TOOLS_APP);
      const key = `after-${crypto.randomUUID().slice(0, 8)}`;
      await startHeldTurn(page, `e2e-hang:${key}`, key);

      const later = unique('Then write a summary');
      await composer(page).fill(later);
      const more = visible(page.getByRole('button', { name: 'More ways to send' }));
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expectAccessible(page, 'composer while iHub is working, send menu open');
      await visible(page.getByRole('menuitem', { name: /Send after this answer/ })).click();
      await expect(pendingItems(page)).toHaveCount(1);
      await expect(pendingItems(page).first()).toContainText(
        `Will be sent as the next message: ${later}`
      );

      await stub.release(key);
      // The running answer is the stub's answer to the hang, nothing more.
      await expect(shown(page, `E2E released: ${key}`)).toBeVisible({ timeout: 30_000 });
      // The message is the next turn: its question, then its answer.
      const nextAnswer = shown(page, `E2E reply to: ${later}`);
      await expect(nextAnswer).toBeVisible({ timeout: 30_000 });
      await expect(pendingItems(page)).toHaveCount(0);
      await expect(visible(page.getByRole('button', { name: 'Stop answer' }))).toHaveCount(0);
      await expect(applied(page)).toHaveCount(0);
      const released = transcript(page).getByText(`E2E released: ${key}`).filter({ visible: true });
      await expect(released).not.toContainText(later);

      await page.reload();
      await expect(shown(page, `E2E released: ${key}`)).toBeVisible({ timeout: 15_000 });
      await expect(nextAnswer).toBeVisible();
      await expect(visible(transcript(page).getByText(later, { exact: true }))).toHaveCount(1);
    }
  );

  test(
    'four messages are reached and removed by keyboard at 320 px in German; a removed one is never read',
    { tag: '@gate' },
    async ({ page }) => {
      await signInPage(page, USER);
      await page.setViewportSize({ width: 320, height: 640 });
      const models = page.waitForResponse(
        response => response.url().includes('/api/models') && response.ok()
      );
      await page.goto(`/apps/${TOOLS_APP}?language=de`);
      await models;
      await page.waitForLoadState('networkidle');
      const key = `de-${crypto.randomUUID().slice(0, 8)}`;
      await composerDe(page).fill(`e2e-hang:${key}`);
      await visible(page.getByRole('button', { name: 'Senden', exact: true })).click();
      await waitForHang(key);
      await expect(visible(page.getByRole('button', { name: 'Antwort stoppen' }))).toBeVisible();

      const text =
        'Bitte verwenden Sie die Zahlen aus dem Geschäftsbericht 2025 und nicht die aus dem Vorjahr';
      const tag = crypto.randomUUID().slice(0, 6);
      for (const n of [1, 2, 3, 4]) {
        await typeAndEnter(page, `${n}-${tag}: ${text}`, composerDe(page));
        // Two rows are shown; from the third on, the rest fold behind "N ausstehend".
        if (n <= 2) await expect(pendingItems(page)).toHaveCount(n);
        else {
          await expect(
            strip(page).getByRole('button', { name: `${n} ausstehend · Alle anzeigen` })
          ).toBeVisible();
        }
      }
      const list = strip(page).getByRole('list', { name: 'In diesem Chat ausstehend' });
      await expect(list).toBeVisible();
      const disclosure = strip(page).getByRole('button', { name: '4 ausstehend · Alle anzeigen' });
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await expect(pendingItems(page)).toHaveCount(4);
      await expectAccessible(page, 'composer at 320 px in German, four messages waiting');

      // Nothing scrolls sideways: not the page, not the strip, no row past the edge.
      const widths = await page.evaluate(() => {
        const root = [...document.querySelectorAll('[data-testid="pending-work-strip"]')].find(
          node => node.offsetParent !== null
        );
        return {
          page: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          strip: [root.scrollWidth, root.clientWidth],
          rightmost: Math.max(
            ...[...root.querySelectorAll('li, button')].map(
              node => node.getBoundingClientRect().right
            )
          )
        };
      });
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);
      expect(widths.strip[0]).toBeLessThanOrEqual(widths.strip[1]);
      expect(widths.rightmost).toBeLessThanOrEqual(widths.viewport);

      // Shift+Tab from the disclosure reaches the fourth item's remove button.
      await page.keyboard.press('Shift+Tab');
      const fourth = strip(page).getByRole('button', {
        name: new RegExp(`^Nachricht entfernen: 4-${tag}:`)
      });
      await expect(fourth).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(pendingItems(page)).toHaveCount(3);
      await expect(
        strip(page).getByRole('button', { name: new RegExp(`^Nachricht entfernen: 3-${tag}:`) })
      ).toBeFocused();
      await expect(announcer(page)).toHaveText('Ihre Nachricht wurde entfernt');

      // The answer ends without a next step: the three left are the next turn, the
      // removed one is in no request the model got.
      await stub.release(key);
      await expect(pendingItems(page)).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(async () => (await stub.requests(`1-${tag}`)).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(await stub.requests(`4-${tag}`)).toEqual([]);
    }
  );

  test(
    'only the chat’s owner sends into the run; an admin who reads the chat is offered nothing',
    { tag: '@gate' },
    async ({ page }) => {
      await signInPage(page, USER);
      await openApp(page, TOOLS_APP);
      const key = `owner-${crypto.randomUUID().slice(0, 8)}`;
      await startHeldTurn(page, `e2e-hang:${key}`, key);
      const chatId = new URL(page.url()).pathname.split('/c/')[1];
      expect(chatId).toBeTruthy();

      const owner = await signedIn(USER);
      const read = await (await owner.get(`/api/chats/${chatId}`)).json();
      expect(read.maySteer).toBe(true);
      const runId = read.chat.activeRunId;
      expect(runId).toBeTruthy();

      const message = { kind: 'steer', message: 'Use the newer report' };
      for (const [who, credentials] of [
        ['another user', OTHER],
        ['the admin', ADMIN]
      ]) {
        const api = await signedIn(credentials);
        const refused = await api.post(`/api/runs/${runId}/human-events`, { data: message });
        expect(refused.status(), who).toBe(403);
        expect((await refused.json()).code, who).toBe('RUN_STEER_FORBIDDEN');
      }
      // The admin reads the chat, and is told not to send into it.
      const admin = await signedIn(ADMIN);
      const adminRead = await admin.get(`/api/chats/${chatId}`);
      expect(adminRead.status()).toBe(200);
      expect((await adminRead.json()).maySteer).toBe(false);
      // The owner's page is not stopped by any of it.
      expect((await stub.stats()).hanging).toContain(key);
      await expect(visible(page.getByRole('button', { name: 'Stop answer' }))).toBeVisible();
    }
  );
});
