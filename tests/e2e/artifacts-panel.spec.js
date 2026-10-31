// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import { SHARE_ID, mockSharedChatWithArtifacts } from './helpers/sharedChatWithArtifacts.js';

/**
 * The Artifacts panel (#3055), in a shared chat: it lists the files the
 * snapshot named, previews them, and downloads a selection or everything as
 * one ZIP through the share's routes. The share routes are intercepted, so
 * the test needs no model and no stored data.
 */
test.describe('Artifacts panel in a shared chat', () => {
  test('lists, previews and downloads the chat files as a ZIP', async ({ page }) => {
    const { zipRequests } = await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);

    await page.getByTestId('open-artifacts').click();
    const panel = page.getByRole('dialog', { name: /Artifacts/ });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole('list', { name: 'Files of this chat' }).getByRole('listitem')
    ).toHaveCount(3);

    // The newest file is listed first and previewed as rendered Markdown.
    await expect(panel.getByRole('heading', { name: 'Demo' })).toBeVisible();

    // Code as text, JSON pretty-printed.
    await panel.getByRole('button', { name: /^src\/index\.js/ }).click();
    await expect(panel.getByLabel('Content of src/index.js')).toContainText(
      'console.log("hello, world");'
    );
    await panel.getByRole('button', { name: /^package\.json/ }).click();
    await expect(panel.getByLabel('Content of package.json')).toContainText('"name": "demo"');

    // A selection, then everything.
    await panel.getByRole('checkbox', { name: 'Select src/index.js' }).check();
    await panel.getByRole('checkbox', { name: 'Select package.json' }).check();
    const selected = page.waitForEvent('download');
    await panel.getByRole('button', { name: /Download selected/ }).click();
    expect((await selected).suggestedFilename()).toBe('A demo project.zip');
    expect(zipRequests.at(-1).artifactIds).toHaveLength(2);

    const all = page.waitForEvent('download');
    await panel.getByRole('button', { name: /Download all/ }).click();
    await all;
    expect(zipRequests.at(-1).artifactIds).toBeUndefined();

    // Escape closes it and gives focus back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('open-artifacts')).toBeFocused();
  });

  test('is operable with the keyboard alone', async ({ page }) => {
    await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);
    await page.getByTestId('open-artifacts').focus();
    await page.keyboard.press('Enter');

    const panel = page.getByRole('dialog', { name: /Artifacts/ });
    await expect(panel.getByRole('button', { name: 'Close artifacts' })).toBeFocused();
    // Focus stays inside the dialog.
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('Tab');
    expect(await panel.evaluate(el => el.contains(document.activeElement))).toBe(true);
  });
});
