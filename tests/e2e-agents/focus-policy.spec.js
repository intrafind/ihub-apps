// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  composer,
  counter,
  openApp,
  sendMessage,
  signInPage,
  stub,
  transcript
} from './helpers.mjs';
import { APPROVAL_APP, TOOLS_APP, USER } from '../config/agents-scenario.mjs';

/**
 * Shared run UI parts (#3191, #3782) in a real browser against the real server:
 *
 * - A card that appears while the person types (an approval, a question of the
 *   assistant) does not take the keyboard focus: the focus and the text stay
 *   where the person types, and the card is said through the page's one live
 *   region instead. An Enter in the composer sends the message; it never
 *   answers the card.
 * - The question card is a group in the page, not a modal dialog: Tab moves on
 *   past its last control.
 *
 * The list of what waits in a chat is checked in the real composer, by keyboard
 * with four items at 320 px in German: steer.spec.js.
 *
 * The cards come from the model stub: the script `hold-then-call` holds the
 * model's tool call until the spec releases it, so the person is typing when the
 * card arrives. The chat input is disabled while an answer runs (with the
 * feature `steering` off, as seeded), so the person types into the app search
 * (Ctrl+K), a text field that is open during a run.
 */

/** The page's one polite live region (`AnnouncerProvider`). */
const announcer = page => page.getByTestId('announcer');
/** Longer than `RECENT_INTERACTION_MS` (1000) in client/src/shared/utils/focusPolicy.js. */
const QUIET_MS = 1300;
/** The app search of the shell (Ctrl+K). */
const appSearch = page => page.getByPlaceholder('Search apps...');

/** The marker of a tool call the stub holds until `stub.release(key)`. */
const heldCall = (key, tool, args) =>
  `e2e-script:hold-then-call hold=${key} tool=${tool} args=${JSON.stringify(args)}`;

/**
 * Send `message`, then type `text` into the app search while the answer runs.
 *
 * @returns {Promise<import('@playwright/test').Locator>} the search field
 */
async function typeElsewhereWhileItRuns(page, message, text) {
  await sendMessage(page, message);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const search = appSearch(page);
  await expect(search).toBeFocused();
  // The search empties itself whenever its app list is built anew (it is loaded on the
  // first open and set twice): wait for the list, then type until the text stays.
  await expect(page.getByRole('dialog').getByRole('option').first()).toBeVisible();
  await expect(async () => {
    await search.fill('');
    await page.keyboard.type(text);
    await expect(search).toHaveValue(text, { timeout: 500 });
    // Still there a moment later: no late rebuild of the list emptied it.
    await page.waitForTimeout(300);
    expect(await search.inputValue()).toBe(text);
  }).toPass({ timeout: 10_000 });
  return search;
}

test.describe('Focus policy of the cards', () => {
  test.afterEach(async () => {
    // A failed test must not leave a model call waiting for the next one.
    await stub.releaseAll();
  });

  test(
    'an approval that appears while the person types does not take the focus, and Enter in the composer does not approve',
    { tag: '@gate' },
    async ({ page }) => {
      await signInPage(page, USER);
      const key = `focus-${crypto.randomUUID().slice(0, 8)}`;
      await openApp(page, APPROVAL_APP);

      const search = await typeElsewhereWhileItRuns(
        page,
        heldCall(key, 'e2e_counter_write', { key, value: 'approved by Enter' }),
        'Cha'
      );
      // The call arrives while the person types: the app asks for approval.
      await stub.release(key);
      // The chat list is rendered for narrow and for wide screens; one copy is hidden.
      const card = page.getByTestId('tool-approval-card').filter({ visible: true });
      await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      await expect(search).toBeFocused();
      await expect(card).not.toBeFocused();
      await expect(announcer(page)).toHaveText('Approval needed: Count a write');
      await page.keyboard.type('t');
      await expect(search).toHaveValue('Chat');

      // Back in the composer: Enter sends the message, it does not approve the call.
      await page.keyboard.press('Escape');
      const input = composer(page);
      await expect(input).toBeEditable();
      await input.click();
      await page.keyboard.type('Use the newer numbers');
      await page.keyboard.press('Enter');
      await expect(transcript(page).getByText('Use the newer numbers')).toBeVisible();
      // Wait until the turn the Enter started is over: an approval it had sent along
      // would have run the write by then.
      await expect(
        transcript(page).getByText('E2E reply to: Use the newer numbers').filter({ visible: true })
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(page.getByTestId('tool-approval-decision')).toHaveCount(0);
      await expect(card.getByText('You approved this call.')).toHaveCount(0);
      expect(await counter.count(key)).toBe(0);
    }
  );

  test(
    'an approval that appears while nobody types takes the focus, and keeps it when the run pauses',
    { tag: '@gate' },
    async ({ page }) => {
      await signInPage(page, USER);
      const key = `free-${crypto.randomUUID().slice(0, 8)}`;
      await openApp(page, APPROVAL_APP);

      // Sent by keyboard, as a keyboard user does; then nobody types anywhere. The
      // composer is disabled while the answer runs.
      const input = composer(page);
      await input.fill(heldCall(key, 'e2e_counter_write', { key, value: 'focus test' }));
      await input.press('Enter');
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await page.waitForTimeout(QUIET_MS);
      await stub.release(key);

      const card = page.getByTestId('tool-approval-card').filter({ visible: true });
      await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      await expect(card).toBeFocused();
      // The run has paused for the decision: the composer is open again, and it did not
      // take the focus back at the end of the turn.
      await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(input).toBeEditable();
      await expect(card).toBeFocused();
      // Focused, not merely visible: Tab goes on to its first button.
      await page.keyboard.press('Tab');
      await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeFocused();
      expect(await counter.count(key)).toBe(0);
    }
  );

  test(
    'a question that appears while the person types does not take the focus; it is a group that Tab leaves',
    { tag: '@gate' },
    async ({ page }) => {
      await signInPage(page, USER);
      const key = `question-${crypto.randomUUID().slice(0, 8)}`;
      await openApp(page, TOOLS_APP);

      const search = await typeElsewhereWhileItRuns(
        page,
        heldCall(key, 'ask_user', {
          question: 'Which year?',
          input_type: 'select',
          options: [
            { label: '2024', value: '2024' },
            { label: '2025', value: '2025' }
          ]
        }),
        'Cha'
      );
      await stub.release(key);
      const group = page.getByRole('group', { name: 'Which year?' });
      await expect(group).toBeVisible();
      await expect(search).toBeFocused();
      await expect(announcer(page)).toHaveText(/The assistant asks: Which year\?/);
      await page.keyboard.type('t');
      await expect(search).toHaveValue('Chat');
      await page.keyboard.press('Escape');

      // A group in the page, not a modal dialog, and no Tab trap.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(group).not.toHaveAttribute('aria-modal', /.*/);
      await group.getByRole('option', { name: /2025/ }).click();
      const submit = group.getByRole('button', { name: 'Submit answer' });
      await submit.focus();
      await page.keyboard.press('Tab');
      expect(await group.evaluate(node => node.contains(document.activeElement))).toBe(false);
    }
  );
});
