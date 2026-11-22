// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  counter,
  openApp,
  restartServer,
  sendMessage,
  serverStatus,
  shown,
  signInPage,
  stub,
  transcript,
  unique
} from './helpers.mjs';
import { TOOLS_APP, USER } from '../config/agents-scenario.mjs';

/**
 * Read-only tool calls of one model step run side by side when the feature
 * `parallelToolCalls` is on, and one after the other when it is off (#2485).
 *
 * "At the same time" is read off the counter of the test tools, never off a
 * clock: the spec holds the counter's reads (`counter.hold()`), so a call of
 * `e2e_counter_read` stays running until the spec lets it go, and the counter
 * says which reads wait (`counter.waiting()`). Two keys in that list were read
 * at the same time; one key means the second call has not started.
 *
 * `e2e_counter_read` is a read by declaration (its definition says
 * `sideEffect: 'read'`), `list_scheduled_tasks` is one of iHub's own, and
 * `e2e_counter_write` is a write.
 */

/** The rows of the activity list of the newest answer. */
const rows = page => transcript(page).getByRole('list').last().getByRole('listitem');
/** The rows that are running: each shows the spinner. */
const runningRows = page => rows(page).locator('svg.animate-spin');
/**
 * The rows are these calls, top to bottom. A row is matched by the title of its
 * action: a stored answer words the row differently ("Ran …") than a live one.
 */
async function expectRows(page, titles) {
  await expect(rows(page)).toHaveCount(titles.length);
  for (const [index, title] of titles.entries()) {
    await expect(rows(page).nth(index)).toContainText(title);
  }
}

const parallel = (tools, args) =>
  unique(`e2e-tools-parallel:${tools.join(',')}:${JSON.stringify(args)}`);

/** The titles of the two calls of the order test, in the order the model asks for them. */
const CALL_ORDER = ['Read the counter', 'List scheduled tasks'];

/** A counter key of this test only. */
const key = name => `${name}-${unique('k').slice(-8)}`;

test.describe('Read-only tool calls side by side', () => {
  test.afterEach(async () => {
    // A failed test must leave no read waiting and no model call hanging.
    await counter.reset();
    await stub.releaseAll();
  });

  test.describe('with the feature on', () => {
    let seeded;

    test.beforeAll(async () => {
      seeded = (await serverStatus()).overlay || {};
      await restartServer({
        overlay: { ...seeded, features: { ...seeded.features, parallelToolCalls: true } }
      });
    });

    test.afterAll(async () => {
      await restartServer({ overlay: seeded });
    });

    test('two reads show as two running rows at once', { tag: '@gate' }, async ({ page }) => {
      await signInPage(page, USER);
      await openApp(page, TOOLS_APP);
      const [first, second] = [key('first'), key('second')];
      await counter.hold();

      const message = parallel(
        ['e2e_counter_read', 'e2e_counter_read'],
        [{ key: first }, { key: second }]
      );
      await sendMessage(page, message);

      // Both reads reached the counter while neither was answered.
      await expect
        .poll(() => counter.waiting(), { message: 'the reads that wait', timeout: 30_000 })
        .toEqual([first, second]);
      await expect(rows(page)).toHaveCount(2);
      await expect(runningRows(page)).toHaveCount(2);

      expect(await counter.release()).toBe(2);
      await expect(shown(page, 'E2E tool results seen: 2')).toBeVisible({ timeout: 30_000 });
      await expect(transcript(page).getByRole('button', { name: /2 calls/ })).toBeVisible();

      // What the model was sent next: both results, in the order of its calls.
      const requests = await stub.requests(message);
      const results = requests
        .at(-1)
        .messages.filter(entry => entry.role === 'tool')
        .map(entry => JSON.parse(entry.content).key);
      expect(results).toEqual([first, second]);
    });

    test(
      'the rows stand in call order while the second call is done first, and after a reload',
      { tag: '@gate' },
      async ({ page }) => {
        await signInPage(page, USER);
        await openApp(page, TOOLS_APP);
        const held = key('held');
        await counter.hold();

        // The first call waits at the counter; the second one needs no counter and ends at once.
        await sendMessage(
          page,
          parallel(['e2e_counter_read', 'list_scheduled_tasks'], [{ key: held }, {}])
        );
        await expect.poll(() => counter.waiting(), { timeout: 30_000 }).toEqual([held]);
        await expectRows(page, CALL_ORDER);
        // One row still runs: the first. The second is done and stays below it.
        await expect(runningRows(page)).toHaveCount(1);
        await expect(rows(page).first().locator('svg.animate-spin')).toHaveCount(1);

        await counter.release();
        await expect(shown(page, 'E2E tool results seen: 2')).toBeVisible({ timeout: 30_000 });

        // The summary of a finished answer folds the rows away; it opens them again.
        const openRows = async () => {
          const summary = transcript(page).locator('button[aria-expanded][aria-controls]').last();
          await expect(summary).toHaveAttribute('aria-expanded', 'false');
          await summary.click();
        };
        await openRows();
        await expectRows(page, CALL_ORDER);

        // The stored answer, read again from the server.
        await page.reload();
        await expect(shown(page, 'E2E tool results seen: 2')).toBeVisible({ timeout: 30_000 });
        await openRows();
        await expectRows(page, CALL_ORDER);
      }
    );

    test(
      'a write in the same step: the calls run one after the other',
      { tag: '@gate' },
      async ({ page }) => {
        await signInPage(page, USER);
        await openApp(page, TOOLS_APP);
        const [read, written] = [key('read'), key('written')];
        await counter.hold();

        await sendMessage(
          page,
          parallel(['e2e_counter_read', 'e2e_counter_write'], [{ key: read }, { key: written }])
        );
        await expect.poll(() => counter.waiting(), { timeout: 30_000 }).toEqual([read]);
        // The read is still running, and the write has not happened.
        await expect(runningRows(page)).toHaveCount(1);
        expect(await counter.count(written)).toBe(0);

        await counter.release();
        await expect(shown(page, 'E2E tool results seen: 2')).toBeVisible({ timeout: 30_000 });
        expect(await counter.count(written)).toBe(1);
      }
    );
  });

  test(
    'with the feature off, two reads run one after the other',
    { tag: '@gate' },
    async ({ page }) => {
      const { overlay } = await serverStatus();
      expect(overlay.features?.parallelToolCalls, 'the feature is off as seeded').not.toBe(true);
      await signInPage(page, USER);
      await openApp(page, TOOLS_APP);
      const [first, second] = [key('first'), key('second')];
      await counter.hold();

      const message = parallel(
        ['e2e_counter_read', 'e2e_counter_read'],
        [{ key: first }, { key: second }]
      );
      await sendMessage(page, message);

      // Only the first read reached the counter: the second call waits for it.
      await expect.poll(() => counter.waiting(), { timeout: 30_000 }).toEqual([first]);
      await expect(runningRows(page)).toHaveCount(1);
      // Still so after the page had the time to draw a second running row.
      await expect(rows(page).first().locator('svg.animate-spin')).toHaveCount(1);
      expect(await counter.waiting()).toEqual([first]);

      expect(await counter.release()).toBe(1);
      await expect.poll(() => counter.waiting(), { timeout: 30_000 }).toEqual([second]);
      await expect(runningRows(page)).toHaveCount(1);

      expect(await counter.release()).toBe(1);
      await expect(shown(page, 'E2E tool results seen: 2')).toBeVisible({ timeout: 30_000 });

      const requests = await stub.requests(message);
      const results = requests
        .at(-1)
        .messages.filter(entry => entry.role === 'tool')
        .map(entry => JSON.parse(entry.content).key);
      expect(results).toEqual([first, second]);
    }
  );
});
