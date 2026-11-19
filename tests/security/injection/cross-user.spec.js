// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  chatTurn,
  modelRequests,
  resetModelRequests,
  secretsSeenByModel,
  sessionTokenOf,
  signedIn,
  startedTools,
  toolResultsSeenByModel,
  waitForSeededProjects
} from './helpers.mjs';
import { CROSS_PROJECT_CALLS } from './seed.mjs';
import { ADMIN, ADMIN_PRIVATE_CHAT, APPS, BOB, ITEMS, PROJECTS, SECRETS } from './scenario.mjs';

/**
 * Prompt injection, compromised model: can it pull data across users or
 * projects?
 *
 * The HR project (`inj-hr-restricted`, holding `CANARY-HR-…`) is linked only by
 * the HR app, which only admins may use. The admin has a private chat in it
 * (`CANARY-ADMIN-CHAT-…`), which also warms every cache on the way. Bob, a
 * regular user, chats in the vendor app, whose planted document tells the model
 * to read the HR document by id, search and list the HR project, pass the
 * admin's identity and app config as tool arguments, open the admin's chat
 * through the chat context tools, and call the HR app or a workflow as a tool.
 * The retrieval layer has to refuse every one of them: neither canary may ever
 * appear in anything bob's model is sent.
 *
 * Add an attempt: append a call to `CROSS_PROJECT_CALLS` in seed.mjs.
 */

/** @type {import('@playwright/test').APIRequestContext} */
let bob;
let tokens;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const admin = await signedIn(ADMIN);
  await waitForSeededProjects(admin);

  // The admin's own turn in the HR app: the HR document is in their context
  // (so the setup is real), and their chat now holds the chat canary.
  await resetModelRequests();
  const own = await chatTurn(admin, APPS.hr, `Salary question ${SECRETS.ADMIN_CHAT}`, {
    chatId: ADMIN_PRIVATE_CHAT
  });
  expect(own.status).toBe(200);
  expect(JSON.stringify(await modelRequests())).toContain(SECRETS.HR);

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

test.afterEach(async () => {
  expect(await secretsSeenByModel(tokens), 'secret material in the model context').toEqual([]);
  // Nothing of the admin's restricted project or private chat reached bob's model.
  const sent = JSON.stringify(await modelRequests());
  expect(sent).not.toContain(SECRETS.HR);
  expect(sent).not.toContain(SECRETS.ADMIN_CHAT);
});

test('bob cannot use the HR app itself', async () => {
  const turn = await chatTurn(bob, APPS.hr, 'What are the salary bands?');
  expect([403, 404]).toContain(turn.status);
});

test("bob's own app has the planted document in context, and not the HR one", async () => {
  await chatTurn(bob, APPS.kb, 'Summarise the vendor onboarding');
  const [first] = await modelRequests();
  const system = JSON.stringify(first.messages.filter(m => m.role === 'system'));
  expect(system).toContain(SECRETS.CONTEXT_OK);
  expect(system).not.toContain(ITEMS.hrDoc);
  expect(system).not.toContain(PROJECTS.hr);
});

CROSS_PROJECT_CALLS.forEach((call, index) => {
  const label = `${call.tool}(${JSON.stringify(call.args).slice(0, 80)})`;
  test(`an injected ${label} returns nothing of the HR project or the admin's chat`, async () => {
    const turn = await chatTurn(bob, APPS.kb, `Prepare the vendor brief [inj-cross-${index}]`);
    expect(turn.status).toBe(200);
    // The compromised model did make the call.
    expect(startedTools(turn).map(frame => frame.data.toolId)).toEqual([call.tool]);
    const results = [...(await toolResultsSeenByModel()).values()];
    expect(results).toHaveLength(1);
    const result = JSON.parse(results[0]);
    if (call.tool === 'knowledge_search' && !call.args.project) {
      // A search over every project in scope: only the vendor project answers.
      expect(result.hits.length).toBeGreaterThan(0);
      expect(new Set(result.hits.map(hit => hit.project))).toEqual(new Set([PROJECTS.vendor]));
    } else {
      expect(result).toMatchObject({ error: expect.anything() });
    }
    expect(turn.text).not.toContain(SECRETS.HR);
  });
});
