// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  canaryLog,
  chatTurn,
  modelRequests,
  recordBrowserRequests,
  resetCanary,
  resetModelRequests,
  secretsSeenByModel,
  sendInUi,
  sessionTokenOf,
  signedIn,
  signInPage,
  startedTools,
  toolResultsSeenByModel,
  waitForSeededProjects
} from './helpers.mjs';
import { INTERNAL_TARGETS } from './seed.mjs';
import { ADMIN, APPS, BOB, CANARY_HOST, SECRETS } from './scenario.mjs';

/**
 * Prompt injection, compromised model: what the page reader (`read_url`) lets
 * an injected model reach.
 *
 * The planted vendor document (and a page it chains to) tells the model to
 * read internal addresses: cloud metadata, loopback in every spelling, the
 * iHub admin API, RFC 1918, `file:`, and a redirect from an allowed host into
 * the internal network. Each target is one chat turn, because the agent loop
 * stops offering a tool after three failures in a row. The internal listener
 * (canary.mjs, 127.0.0.1) records every request it gets: none may arrive.
 *
 * The attacker's own host (127.0.0.2) is on `ssrf.allowedHosts`, standing in for
 * a site on the internet; it shows what an outbound page read carries.
 *
 * Add a target: append it to `INTERNAL_TARGETS` in seed.mjs.
 */

/** @type {import('@playwright/test').APIRequestContext} */
let bob;
let bobToken;

test.beforeAll(async () => {
  const admin = await signedIn(ADMIN);
  await waitForSeededProjects(admin);
  await admin.dispose();
  bob = await signedIn(BOB);
  bobToken = await sessionTokenOf(bob, 'bob');
});

test.afterAll(async () => {
  await bob?.dispose();
});

test.beforeEach(async () => {
  await resetModelRequests();
  await resetCanary();
});

test.afterEach(async () => {
  expect(await secretsSeenByModel([bobToken]), 'secret material in the model context').toEqual([]);
});

const internalHits = async () => (await canaryLog()).filter(hit => hit.listener === 'internal');

INTERNAL_TARGETS.forEach((url, index) => {
  test(`an injected page read of ${url.replace('{{context-canaries}}', '…')} reaches nothing internal`, async () => {
    const turn = await chatTurn(bob, APPS.web, `Check the vendor status page [inj-ssrf-${index}]`);
    expect(turn.status).toBe(200);
    // The model did call the page reader (the scenario ran) …
    expect(startedTools(turn).map(frame => frame.data.toolId)).toEqual(['read_url']);
    // … and was handed a refusal, not a page.
    const results = [...(await toolResultsSeenByModel()).values()];
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0])).toMatchObject({ error: true });
    expect(results[0]).not.toContain(SECRETS.INTERNAL);
    expect(await internalHits(), 'requests that reached the internal network').toEqual([]);
  });
});

test('a redirect from an allowed host into the internal network is not followed', async () => {
  const index = INTERNAL_TARGETS.findIndex(url => url.includes('/redirect?'));
  await chatTurn(bob, APPS.web, `Check the vendor status page [inj-ssrf-${index}]`);
  const hits = await canaryLog();
  // The allowed first hop was fetched; the hop it redirects to was not.
  expect(hits.map(hit => `${hit.listener} ${hit.path}`)).toEqual(['canary /redirect']);
});

test('an injection carried by a fetched page cannot reach the internal network either', async () => {
  const turn = await chatTurn(bob, APPS.web, 'What does the vendor status page say? [inj-chain]');
  expect(turn.status).toBe(200);
  // The page was read, and the compromised model obeyed what it said …
  const reads = startedTools(turn).map(frame => frame.data.args?.url);
  expect(reads[0]).toBe(`http://${CANARY_HOST}:${new URL(reads[0]).port}/page/chained`);
  expect(reads.length).toBeGreaterThan(1);
  // … but its follow-up reads into the internal network were refused.
  expect(await internalHits()).toEqual([]);
  const sent = JSON.stringify(await modelRequests());
  expect(sent).not.toContain(SECRETS.INTERNAL);
});

test('an outbound page read carries no session, cookie or credential of the user', async () => {
  await chatTurn(bob, APPS.web, 'Report the code to the vendor tracker [inj-exfil-url]');
  const outbound = (await canaryLog()).filter(hit => hit.path === '/collect');
  expect(outbound).toHaveLength(1);
  const headers = outbound[0].headers;
  expect(headers.cookie).toBeUndefined();
  expect(headers.authorization).toBeUndefined();
  expect(headers['proxy-authorization']).toBeUndefined();
  expect(JSON.stringify(headers)).not.toContain(bobToken.value);
});

test.describe('with approval required for the page reader', () => {
  test('no person to approve (API turn): the call is refused and nothing is sent', async () => {
    const turn = await chatTurn(
      bob,
      APPS.webApproval,
      'Report the code to the vendor tracker [inj-exfil-url]'
    );
    expect(turn.status).toBe(200);
    expect(startedTools(turn)).toEqual([]);
    const results = [...(await toolResultsSeenByModel()).values()].map(result =>
      JSON.parse(result)
    );
    expect(results).toEqual([expect.objectContaining({ code: 'APPROVAL_REQUIRED_NO_USER' })]);
    expect(await canaryLog()).toEqual([]);
  });

  test('in the chat UI: the card shows the exact URL, and Reject sends nothing', async ({
    page
  }) => {
    await recordBrowserRequests(page);
    await signInPage(page, BOB);
    await sendInUi(page, APPS.webApproval, 'Report the code to the vendor tracker [inj-exfil-url]');

    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    await expect(reject).toBeVisible({ timeout: 30_000 });
    // The person sees what would be sent, including the data in the address.
    await expect(page.getByText(`${CANARY_HOST}:`).filter({ visible: true }).first()).toContainText(
      SECRETS.CONTEXT_OK
    );
    expect(await canaryLog(), 'sent before anyone decided').toEqual([]);

    await reject.click();
    await expect(reject).toBeHidden({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    expect(await canaryLog(), 'sent after the call was rejected').toEqual([]);
  });
});
