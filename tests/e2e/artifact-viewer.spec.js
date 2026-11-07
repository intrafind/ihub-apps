// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * The immersive artifact viewer (#3184), over shared chats whose share routes
 * are intercepted: no model, no stored chat. A click on the artifact's card
 * in the transcript opens it; the HTML page fills the window under one slim
 * toolbar.
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
  expect(box.height).toBeGreaterThanOrEqual(viewport.height * 0.9);
}

test.describe('Artifact viewer in a shared chat', () => {
  test('a click on the card opens the artifact edge to edge, Esc closes it', async ({ page }) => {
    await mockShares(page);
    await page.goto(`/share/${CHAT_SHARE}`);

    const card = page.getByTestId('generated-file-open');
    await expect(card).toBeVisible();
    await card.click();

    const viewer = page.getByRole('dialog', { name: /dashboard\.html/ });
    await expect(viewer).toBeVisible();
    await expect(page).toHaveURL(/artifact=/);

    const toolbar = page.getByTestId('artifact-viewer-toolbar');
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox.height).toBeLessThanOrEqual(56);

    const frame = viewer.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(
      page.frameLocator('[data-testid="artifact-viewer"] iframe').locator('#hello')
    ).toHaveText('Hello dashboard');
    await expectFillsViewport(page, frame);

    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(page).not.toHaveURL(/artifact=/);
    await expect(card).toBeFocused();
  });

  test('?artifact= reopens the viewer on reload, and Back closes it', async ({ page }) => {
    await mockShares(page);
    await page.goto(`/share/${CHAT_SHARE}`);
    await page.getByTestId('generated-file-open').click();
    await expect(page.getByTestId('artifact-viewer')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('artifact-viewer')).toBeVisible();
    await expectFillsViewport(page, page.getByTestId('artifact-viewer').locator('iframe'));

    await page.goBack();
    await expect(page.getByTestId('artifact-viewer')).toBeHidden();
  });

  test('works at phone width without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockShares(page);
    await page.goto(`/share/${CHAT_SHARE}?artifact=${HTML_ID}`);
    await expect(page.getByTestId('artifact-viewer')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
    await expect(page.getByRole('button', { name: 'Close artifact' })).toBeVisible();
  });
});

test.describe('Shared single artifact', () => {
  test('renders immersively: slim toolbar, artifact filling the rest', async ({ page }) => {
    await mockShares(page);
    await page.goto(`/share/${ARTIFACT_SHARE}`);
    const toolbar = page.getByTestId('artifact-viewer-toolbar');
    await expect(toolbar).toBeVisible();
    expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(56);
    const frame = page.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expectFillsViewport(page, frame);
    await expect(page.getByRole('button', { name: 'Close artifact' })).toHaveCount(0);
  });

  test('?embed=1 drops the toolbar', async ({ page }) => {
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
