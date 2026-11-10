// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test, expect } from '@playwright/test';

/**
 * The workspace pane in a real chat (concept "Workspace Pane for Artifacts, Files and
 * Sources", Phase 1). Signs in as the default local admin (`admin` / `password123`) and chats
 * in the File Analyzer app with the e2e model stub, which answers
 * `E2E reply to: <message> (turn N)`. An uploaded text file is what the pane shows.
 */

const ADMIN = { username: 'admin', password: 'password123' };

function contractFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ihub-e2e-'));
  const file = path.join(dir, 'vertrag.txt');
  writeFileSync(
    file,
    'Vertrag Abschnitt 1\nDie Kündigungsfrist beträgt drei Monate zum Quartalsende.\n' +
      'Abschnitt 2\nDie Vergütung erfolgt monatlich.\n'
  );
  return file;
}

const visible = locator => locator.filter({ visible: true }).first();
const input = page => visible(page.getByRole('textbox', { name: 'Type your message' }));
const pane = page => page.getByTestId('workspace-pane');

/**
 * Deletes the chat the page is on. The e2e store is shared by every spec of a run: a chat
 * left behind shows up on other pages (Chat history) and in their accessibility scans.
 */
async function deleteChatOf(page) {
  const match = /\/c\/([^/?#]+)/.exec(page.url());
  if (match) await page.request.delete(`/api/chats/${encodeURIComponent(match[1])}`);
}

async function signIn(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
  const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
  expect(login.ok(), 'sign in as the default admin').toBeTruthy();
}

/** Opens the File Analyzer, sends one question with the contract attached, waits for the answer. */
async function chatWithAFile(page) {
  const models = page.waitForResponse(r => r.url().includes('/api/models') && r.ok());
  await page.goto('/apps/file-analysis');
  await models;
  await page.waitForLoadState('networkidle');
  await page.locator('input[type=file]').first().setInputFiles(contractFile());
  await expect(visible(page.getByText('vertrag.txt'))).toBeVisible();
  await input(page).fill('Please summarize the contract');
  // Send is held back while the attachment is still being read.
  const send = visible(page.getByRole('button', { name: 'Send', exact: true }));
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
  await expect(visible(page.getByText(/\(turn 1\)/))).toBeVisible({ timeout: 30_000 });
}

/** Selects a phrase inside the pane's text, as a mouse drag would. */
async function selectInPane(page, phrase) {
  await expect(page.getByTestId('uploaded-file-body')).toContainText(phrase);
  await page.evaluate(text => {
    const body = document.querySelector('[data-testid="uploaded-file-body"]');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes(text)) node = walker.nextNode();
    const start = node.textContent.indexOf(text);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, phrase);
}

// Each test waits for model turns of the stub.
test.describe.configure({ timeout: 120_000 });

test.describe('Workspace pane in a chat', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(async ({ page }) => signIn(page));
  test.afterEach(async ({ page }) => deleteChatOf(page));

  test('open → docked → full screen → Back steps out one level at a time', async ({ page }) => {
    await chatWithAFile(page);
    const card = visible(page.getByTestId('message-attachment'));
    await card.click();

    await expect(pane(page)).toHaveAttribute('data-state', 'docked');
    await expect(page).toHaveURL(/[?&]file=/);
    await expect(page.getByRole('region', { name: 'Workspace: vertrag.txt' })).toBeVisible();
    await expect(card).toHaveAttribute('aria-current', 'true');
    // The chat reflows next to the pane and keeps its composer.
    await expect(input(page)).toBeVisible();

    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(pane(page)).toHaveAttribute('data-state', 'full');
    await expect(page).toHaveURL(/view=full/);
    await expect(page.getByTestId('composer-dock')).toBeVisible();

    await page.goBack();
    await expect(pane(page)).toHaveAttribute('data-state', 'docked');
    await page.goBack();
    await expect(pane(page)).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]file=/);
  });

  test('keeps chatting while the pane is open, with a passage quoted from it', async ({ page }) => {
    await chatWithAFile(page);
    await visible(page.getByTestId('message-attachment')).click();
    await expect(pane(page)).toHaveAttribute('data-state', 'docked');

    await selectInPane(page, 'Kündigungsfrist beträgt drei Monate');
    const chip = page.getByRole('toolbar', { name: 'Selection actions' });
    await expect(chip).toBeVisible();
    await chip.getByRole('button', { name: 'Ask about' }).click();

    await expect(visible(page.getByTestId('composer-quote'))).toContainText('vertrag.txt');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('What is the notice period?');
    await page.keyboard.press('Enter');

    await expect(visible(page.getByText(/About this passage of "vertrag\.txt"/))).toBeVisible({
      timeout: 30_000
    });
    await expect(visible(page.getByText(/\(turn 2\)/))).toBeVisible({ timeout: 30_000 });
    // The pane stayed open, docked, through the turn.
    await expect(pane(page)).toHaveAttribute('data-state', 'docked');
    await expect(page.getByTestId('composer-quote')).toHaveCount(0);

    // And from the dock in full screen.
    await page.getByRole('button', { name: 'Full screen' }).click();
    await page.getByTestId('composer-dock-expand').click();
    await page.keyboard.type('One more from the dock');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-dock-latest')).toContainText(
      'One more from the dock turn 3',
      {
        timeout: 30_000
      }
    );
    // Esc in the composer never closes the pane; "Open chat" returns to docked.
    await page.keyboard.press('Escape');
    await expect(pane(page)).toHaveAttribute('data-state', 'full');
    await page.getByTestId('composer-dock-open-chat').click();
    await expect(pane(page)).toHaveAttribute('data-state', 'docked');
  });

  test('keyboard: skip link, Ctrl+., the divider and Esc', async ({ page }) => {
    await chatWithAFile(page);
    await input(page).focus();
    await page.keyboard.press('Control+.');
    await expect(page.getByRole('region', { name: 'Workspace: Files' })).toBeVisible();
    await expect(page.locator('#workspace-pane-heading')).toBeFocused();

    // A skip link to the pane while it is open.
    await expect(page.getByRole('link', { name: 'Skip to workspace' })).toHaveCount(1);

    const divider = page.getByRole('separator', { name: 'Resize workspace' });
    const before = Number(await divider.getAttribute('aria-valuenow'));
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', String(before + 16));
    await page.keyboard.press('Home');
    await expect(divider).toHaveAttribute('aria-valuenow', '360');
    await divider.dblclick();
    await expect(divider).toHaveAttribute('aria-valuenow', String(before));

    await page.locator('#workspace-pane-heading').focus();
    await page.keyboard.press('Escape');
    await expect(pane(page)).toBeHidden();
    await expect(page.getByRole('link', { name: 'Skip to workspace' })).toHaveCount(0);
  });
});

test.describe('Workspace pane on a narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => signIn(page));
  test.afterEach(async ({ page }) => deleteChatOf(page));

  test('is a full-screen sheet with a focus trap; "Open chat" keeps the file reopenable', async ({
    page
  }) => {
    await chatWithAFile(page);
    const card = visible(page.getByTestId('message-attachment'));
    await card.click();

    const sheet = page.getByRole('dialog', { name: 'Workspace: vertrag.txt' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('separator')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);

    // Focus stays inside the sheet.
    for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab');
    expect(await sheet.evaluate(el => el.contains(document.activeElement))).toBe(true);

    // The dock's "Open chat" goes back to the chat; the file stays in the URL and on its card.
    await page.getByTestId('composer-dock-expand').click();
    await page.getByTestId('composer-dock-open-chat').click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/[?&]file=/);
    await expect(card).toHaveAttribute('aria-current', 'true');
    await card.click();
    await expect(sheet).toBeVisible();

    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]file=/);
  });
});
