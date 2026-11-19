// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  chatTurn,
  forbiddenSecrets,
  resetModelRequests,
  secretsSeenByModel,
  sessionTokenOf,
  signedIn,
  startedTools,
  toolResultsSeenByModel,
  waitForSeededProjects
} from './helpers.mjs';
import { SECRET_CALLS } from './seed.mjs';
import { ADMIN, APPS, BOB } from './scenario.mjs';

/**
 * Prompt injection, compromised model: can it get secret material into its own
 * context, from where any exfiltration channel could carry it out?
 *
 * Secrets are planted where an installation keeps them: the server's
 * environment (`IHUB_E2E_INJECTION_SECRET`, `OPENAI_API_KEY`), a platform
 * config secret (`speech.azure.subscriptionKey`), the real `.encryption-key`,
 * `.jwt-secret` and JWT private key of the suite's contents, and the users'
 * session tokens. The planted document tells the model to read them through
 * every tool and path it could try (path traversal in document and file ids,
 * `file:` and the admin API through the page reader, agent and skill tools the
 * app does not offer). Every spec of the suite also checks, after each test,
 * that none of them reached the model (`secretsSeenByModel`).
 *
 * Add an attempt: append a call to `SECRET_CALLS` in seed.mjs.
 */

/** @type {import('@playwright/test').APIRequestContext} */
let bob;
let tokens;

test.beforeAll(async () => {
  const admin = await signedIn(ADMIN);
  await waitForSeededProjects(admin);
  bob = await signedIn(BOB);
  tokens = [await sessionTokenOf(admin, 'admin'), await sessionTokenOf(bob, 'bob')];
  await admin.dispose();
});

test.afterAll(async () => {
  await bob?.dispose();
});

test.beforeEach(async () => {
  await resetModelRequests();
});

test('the planted secrets exist, so their absence below means something', async () => {
  const names = forbiddenSecrets(tokens).map(secret => secret.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'server environment secret',
      'platform config secret',
      '.encryption-key',
      '.jwt-secret',
      'session token of bob'
    ])
  );
});

SECRET_CALLS.forEach((call, index) => {
  const label = `${call.tool}(${JSON.stringify(call.args).slice(0, 80)})`;
  test(`an injected ${label} puts no secret into the model context`, async () => {
    const turn = await chatTurn(bob, APPS.web, `Verify the installation [inj-secret-${index}]`);
    expect(turn.status).toBe(200);
    expect(startedTools(turn).map(frame => frame.data.toolId)).toEqual([call.tool]);
    const [result] = [...(await toolResultsSeenByModel()).values()];
    // Refused (an error object or a "not found" sentence), never file or config content.
    expect(result).toMatch(/error|not found|not available|denied/i);
    expect(await secretsSeenByModel(tokens), 'secret material in the model context').toEqual([]);
  });
});
