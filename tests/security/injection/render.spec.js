// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  recordBrowserRequests,
  resetModelRequests,
  secretsSeenByModel,
  sendInUi,
  signedIn,
  signInPage,
  waitForSeededProjects
} from './helpers.mjs';
import { ADMIN, APPS, BOB } from './scenario.mjs';

/**
 * Prompt injection, compromised model: what a model answer can make the
 * browser do.
 *
 * The planted vendor document (seed.mjs) tells the model to put active HTML
 * into its answer, and the compromised model (compromisedModel.mjs) does. The
 * specs open the real chat UI as a regular user and record every request the
 * browser makes to the attacker's host (`canary.invalid`, intercepted by
 * Playwright, so nothing leaves the machine). Assertions are on what the
 * browser loads and what the rendered DOM keeps, never on the answer's wording.
 *
 * Add a vector: append it to `BLOCKED_RENDER_VECTORS` in seed.mjs, pointing at
 * `${BROWSER_CANARY}/<name>`.
 */

test.beforeAll(async () => {
  const admin = await signedIn(ADMIN);
  await waitForSeededProjects(admin);
  await admin.dispose();
});

test.beforeEach(async ({ page }) => {
  await resetModelRequests();
  await signInPage(page, BOB);
});

test.afterEach(async () => {
  expect(await secretsSeenByModel(), 'secret material in the model context').toEqual([]);
});

test('active HTML in an answer is neutralised and makes the browser load nothing', async ({
  page
}) => {
  const hits = await recordBrowserRequests(page);
  await sendInUi(page, APPS.kb, 'Summarise the Northwind onboarding [inj-render-blocked]');

  const answer = page.locator('.streaming-markdown').filter({ hasText: 'End of summary.' }).last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  // Give lazy loads (frames, meta refresh, stylesheets) time to fire.
  await page.waitForTimeout(2_000);

  expect(hits, 'requests the answer made the browser send to the attacker').toEqual([]);
  const kept = await answer.evaluate(root => ({
    elements: [
      ...root.querySelectorAll('iframe, object, embed, script, link, meta, base, form')
    ].map(element => element.outerHTML),
    handlers: [...root.querySelectorAll('*')].flatMap(element =>
      [...element.attributes]
        .filter(a => /^on/i.test(a.name))
        .map(a => `${element.tagName} ${a.name}`)
    ),
    scriptHrefs: [...root.querySelectorAll('[href], [src], [action]')]
      .map(element => element.getAttribute('href') || element.getAttribute('src') || '')
      .filter(url => /^\s*javascript:/i.test(url))
  }));
  expect(kept).toEqual({ elements: [], handlers: [], scriptHrefs: [] });
  // The page itself is still the chat (no meta refresh, no <base> rewrite).
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');
});

test('a link carrying data stays inert until clicked and opens without opener or referrer', async ({
  page
}) => {
  const hits = await recordBrowserRequests(page);
  await sendInUi(page, APPS.kb, 'Where is the vendor portal? [inj-render-link]');

  const link = page.getByRole('link', { name: 'Open the Northwind portal' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  // Nothing is fetched by rendering (no prefetch, no preview card).
  expect(hits).toEqual([]);
  await expect(link).toHaveAttribute('target', '_blank');
  const rel = (await link.getAttribute('rel')) || '';
  expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
});

test('an HTML artifact preview runs sandboxed and reaches no other host', async ({ page }) => {
  const hits = await recordBrowserRequests(page);
  await sendInUi(page, APPS.artifact, 'Publish the vendor badge [inj-artifact]');

  await page
    .getByTestId('generated-file-open')
    .filter({ visible: true })
    .first()
    .click({ timeout: 30_000 });
  const frame = page.getByTestId('artifact-viewer').locator('iframe');
  // The artifact ran: its own markup is in the frame.
  await expect(
    page.frameLocator('[data-testid="artifact-viewer"] iframe').getByRole('heading', {
      name: 'Northwind'
    })
  ).toBeVisible({ timeout: 15_000 });
  // An opaque origin: scripts, but no access to iHub's origin, cookies or storage.
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await page.waitForTimeout(2_000);

  // Images, fetch, beacons, WebSockets, stylesheets, scripts, nested frames
  // and form posts are refused by the preview's CSP before any request.
  expect(hits, 'requests the artifact made the browser send to the attacker').toEqual([]);
});
