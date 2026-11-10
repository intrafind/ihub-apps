// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * The artifact viewer in the workspace pane, over shared chats whose share routes are
 * intercepted: no model, no stored chat. A click on the artifact's card opens it docked next
 * to the chat (which reflows); full screen fills the window under one slim header; below
 * 1024px it is a full-screen sheet. The HTML stays in a sandboxed frame throughout.
 */
const CHAT_SHARE = 'e2e-viewer-chat';
const ARTIFACT_SHARE = 'e2e-viewer-artifact';
const HTML_ID = 'd1b2c3d4e5f60718293a4b5c6d7e8f90';
const HTML = {
  id: HTML_ID,
  kind: 'code',
  mimeType: 'text/plain',
  name: 'dashboard.html',
  bytes: 120,
  createdAt: '2026-10-30T10:00:00.000Z'
};
const PAGE =
  '<!doctype html><html><body style="margin:0"><h1 id="hello">Hello dashboard</h1></body></html>';

async function mockShares(page) {
  await page.route(new RegExp(`/api/shares/${CHAT_SHARE}(/|$|\\?)`), async route => {
    const { pathname } = new URL(route.request().url());
    const rest = pathname.slice(pathname.indexOf(CHAT_SHARE) + CHAT_SHARE.length);
    if (rest === '') {
      return route.fulfill({
        json: {
          share: {
            id: CHAT_SHARE,
            mode: 'authenticated',
            title: 'A dashboard',
            sharedBy: 'Ada',
            createdAt: '2026-10-30T10:05:00.000Z',
            app: { name: { en: 'Chat', de: 'Chat' }, color: '#4f46e5', icon: 'chat-bubble' }
          },
          messages: [
            { id: 'm1', role: 'user', content: 'Build a dashboard.' },
            { id: 'm2', role: 'assistant', content: 'Here it is.', artifacts: [HTML] }
          ],
          version: 1
        }
      });
    }
    if (rest === '/artifacts') return route.fulfill({ json: { items: [HTML] } });
    if (rest === `/artifacts/${HTML_ID}`) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: PAGE
      });
    }
    return route.fulfill({ status: 404, json: { detail: 'Not found', code: 'NOT_FOUND' } });
  });

  await page.route(new RegExp(`/api/shares/${ARTIFACT_SHARE}(/|$|\\?)`), async route => {
    const { pathname } = new URL(route.request().url());
    const rest = pathname.slice(pathname.indexOf(ARTIFACT_SHARE) + ARTIFACT_SHARE.length);
    if (rest === '') {
      return route.fulfill({
        json: {
          share: {
            id: ARTIFACT_SHARE,
            mode: 'public',
            target: 'artifact',
            title: 'dashboard.html',
            sharedBy: 'Ada',
            createdAt: '2026-10-30T10:05:00.000Z',
            artifact: HTML,
            readOnly: true
          },
          messages: [],
          version: 1
        }
      });
    }
    if (rest === `/artifacts/${HTML_ID}`) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: PAGE
      });
    }
    return route.fulfill({ status: 404, json: { detail: 'Not found', code: 'NOT_FOUND' } });
  });
}

async function expectFillsViewport(page, frameLocator) {
  const viewport = page.viewportSize();
  const box = await frameLocator.boundingBox();
  expect(box.x).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(box.height).toBeGreaterThanOrEqual(viewport.height * 0.85);
}

test.describe('Artifact viewer in a shared chat', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a click on the card docks the artifact next to the chat, Esc closes it', async ({
    page
  }) => {
    await mockShares(page);
    await page.goto(`/share/${CHAT_SHARE}`);

    const card = page.getByTestId('generated-file-open');
    await expect(card).toBeVisible();
    await card.click();

    const pane = page.getByRole('region', { name: 'Workspace: dashboard.html' });
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute('data-state', 'docked');
    await expect(page).toHaveURL(/artifact=/);
    // The chat reflows next to the pane: nothing of it is covered.
    const paneBox = await pane.boundingBox();
    const chatBox = await page.getByTestId('workspace-chat-column').boundingBox();
    expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(paneBox.x + 2);
    // The card says it is the one open.
    await expect(card).toHaveAttribute('aria-current', 'true');

    const toolbar = pane.getByTestId('artifact-viewer-toolbar');
    expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(56);
    const frame = pane.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(
      page.frameLocator('[data-testid="artifact-viewer"] iframe').locator('#hello')
    ).toHaveText('Hello dashboard');

    // Focus is in the pane after a click; Esc there closes it and gives focus back.
    await expect(page.locator('#workspace-pane-heading')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pane).toBeHidden();
    await expect(page).not.toHaveURL(/artifact=/);
    await expect(card).toBeFocused();
  });

  test('full screen fills the window; ?artifact= reopens on reload, and Back steps out', async ({
    page
  }) => {
    await mockShares(page);
    await page.goto(`/share/${CHAT_SHARE}`);
    await page.getByTestId('generated-file-open').click();
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page).toHaveURL(/view=full/);
    await expectFillsViewport(page, page.getByTestId('artifact-viewer').locator('iframe'));

    await page.reload();
    await expect(page.getByTestId('workspace-pane')).toHaveAttribute('data-state', 'full');

    await page.goBack();
    await expect(page.getByTestId('workspace-pane')).toHaveAttribute('data-state', 'docked');
    await page.goBack();
    await expect(page.getByTestId('workspace-pane')).toBeHidden();
  });

  test('works at phone width as a sheet, without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockShares(page);
    await page.goto(`/share/${CHAT_SHARE}?artifact=${HTML_ID}`);
    const sheet = page.getByRole('dialog', { name: 'Workspace: dashboard.html' });
    await expect(sheet).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
    await expect(page.getByRole('button', { name: 'Back to chat' })).toBeVisible();
    await expectFillsViewport(page, sheet.locator('iframe'));
  });
});

test.describe('Shared single artifact', () => {
  test('renders as a page: slim header, artifact filling the rest, nothing to close', async ({
    page
  }) => {
    await mockShares(page);
    await page.goto(`/share/${ARTIFACT_SHARE}`);
    const toolbar = page.getByTestId('artifact-viewer-toolbar');
    await expect(toolbar).toBeVisible();
    expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(56);
    const frame = page.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expectFillsViewport(page, frame);
    await expect(page.getByTestId('artifact-viewer-close')).toHaveCount(0);
    await expect(page.getByTestId('pane-expand')).toHaveCount(0);
  });

  test('?embed=1 drops the header', async ({ page }) => {
    await mockShares(page);
    await page.goto(`/share/${ARTIFACT_SHARE}?embed=1`);
    const frame = page.locator('iframe');
    await expect(frame).toBeVisible();
    await expect(page.getByTestId('artifact-viewer-toolbar')).toHaveCount(0);
    const viewport = page.viewportSize();
    const box = await frame.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(viewport.height - 2);
  });
});
