// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import { SHARE_ID, mockSharedChatWithArtifacts } from './helpers/sharedChatWithArtifacts.js';

/**
 * The Files index of the workspace pane (#3055, concept §7), in a shared chat: it lists the
 * files the snapshot named, opens each in the pane's detail with a back link, and downloads a
 * selection or everything as one ZIP through the share's routes. The share routes are
 * intercepted, so the test needs no model and no stored data.
 */
test.describe('Files index in a shared chat', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lists, opens and downloads the chat files as a ZIP', async ({ page }) => {
    const { zipRequests } = await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);

    await page.getByTestId('open-artifacts').click();
    const pane = page.getByRole('region', { name: 'Workspace: Files' });
    await expect(pane).toBeVisible();
    const list = pane.getByRole('list', { name: 'Files of this chat' });
    await expect(list.getByRole('listitem')).toHaveCount(3);

    // A row opens the detail; the back link returns to the list.
    await list.getByRole('button', { name: /README\.md/ }).click();
    const readme = page.getByRole('region', { name: 'Workspace: README.md' });
    await expect(readme).toBeVisible();
    await expect(readme.getByRole('heading', { name: 'Demo' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Files' }).click();
    await page
      .getByRole('list', { name: 'Files of this chat' })
      .getByRole('button', { name: /package\.json/ })
      .click();
    await expect(page.getByLabel('Content of package.json')).toContainText('"name": "demo"');
    await page.getByRole('button', { name: 'Back to Files' }).click();

    // A selection, then everything.
    const files = page.getByRole('region', { name: 'Workspace: Files' });
    await files.getByRole('checkbox', { name: 'Select src/index.js' }).check();
    await files.getByRole('checkbox', { name: 'Select package.json' }).check();
    await expect(page.getByTestId('files-selection-bar')).toContainText('2 selected');
    const selected = page.waitForEvent('download');
    await page
      .getByTestId('files-selection-bar')
      .getByRole('button', { name: /Download \.zip/ })
      .click();
    expect((await selected).suggestedFilename()).toBe('A demo project.zip');
    expect(zipRequests.at(-1).artifactIds).toHaveLength(2);

    const all = page.waitForEvent('download');
    await files.getByRole('button', { name: /Download all/ }).click();
    await all;
    expect(zipRequests.at(-1).artifactIds).toBeUndefined();

    // Escape (focus in the pane) closes it and gives focus back to the button that opened it.
    await files.getByRole('tab', { name: /Generated/ }).focus();
    await page.keyboard.press('Escape');
    await expect(files).toBeHidden();
    await expect(page.getByTestId('open-artifacts')).toBeFocused();
  });

  test('is operable with the keyboard alone, and not modal', async ({ page }) => {
    await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);
    await page.getByTestId('open-artifacts').focus();
    await page.keyboard.press('Enter');

    const pane = page.getByRole('region', { name: 'Workspace: Files' });
    await expect(pane.locator('#workspace-pane-heading')).toBeFocused();
    // Arrow keys move between the tabs.
    await pane.getByRole('tab', { name: /Generated/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(pane.getByRole('tab', { name: /Uploaded|Sources/ }).first()).toBeFocused();
    // Docked is not modal: Tab can leave the pane for the chat.
    let left = false;
    for (let i = 0; i < 40 && !left; i += 1) {
      await page.keyboard.press('Tab');
      left = !(await pane.evaluate(el => el.contains(document.activeElement)));
    }
    expect(left).toBe(true);
  });
});
