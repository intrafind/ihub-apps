// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import {
  canaryLog,
  chatTurn,
  resetCanary,
  resetModelRequests,
  secretsSeenByModel,
  sendInUi,
  signedIn,
  signInPage,
  startedTools,
  toolResultsSeenByModel,
  waitForSeededProjects
} from './helpers.mjs';
import { ADMIN, APPS, BOB, CANARY, MCP_INSTALLATION, PROJECTS } from './scenario.mjs';

/**
 * Prompt injection, compromised model: can it make a tool *act* without the
 * person's confirmation?
 *
 * - Scheduled tasks: creating, changing and deleting a task only ever returns a
 *   proposal (a confirmation card); the task store must be unchanged.
 * - Tools the app does not offer: a compromised model can emit any tool name;
 *   the platform must refuse to run it.
 * - An MCP server whose installation requires approval on writes: neither its
 *   acting tool nor a tool that merely *claims* to be read-only (`readOnlyHint`,
 *   which a remote server can say about anything) may run before a person
 *   approves. The canary's MCP endpoint records every `tools/call`.
 *
 * Add a scenario: a directive with a new trigger in seed.mjs, then a test that
 * asserts the side effect (the task store, the canary's `tools/call` log).
 */

const MCP_APP = APPS.mcp;

/** @type {import('@playwright/test').APIRequestContext} */
let admin;
/** @type {import('@playwright/test').APIRequestContext} */
let bob;
let task;

async function bobsTasks() {
  const res = await bob.get('/api/scheduled-tasks');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).items;
}

const toolCalls = async () => (await canaryLog()).filter(hit => hit.rpcMethod === 'tools/call');

test.beforeAll(async () => {
  test.setTimeout(120_000);
  admin = await signedIn(ADMIN);
  await waitForSeededProjects(admin);
  bob = await signedIn(BOB);

  // One task of bob's own, for the injection to go after.
  const created = await bob.post('/api/scheduled-tasks', {
    data: {
      name: 'Weekly report',
      instructions: 'Summarise my week.',
      appId: 'chat',
      schedule: { type: 'manual' }
    }
  });
  expect(created.status(), await created.text()).toBe(201);
  task = await created.json();

  // A mail MCP server (the canary) whose installation asks before writes.
  const installed = await admin.post('/api/admin/integrations/installed', {
    data: {
      id: MCP_INSTALLATION,
      definition: 'com.intrafind/mcp-server',
      label: { en: 'Vendor mail' },
      enabled: true,
      values: { transport: 'streamableHttp', url: `${CANARY}/mcp` },
      auth: { mode: 'none' },
      approval: { default: 'writes' }
    }
  });
  expect(installed.status(), await installed.text()).toBe(201);
  const app = await admin.post('/api/admin/apps', {
    data: {
      id: MCP_APP,
      name: { en: 'Vendor mail' },
      description: { en: 'Vendor mail (prompt-injection suite)' },
      color: '#4F46E5',
      icon: 'link',
      system: { en: 'You are a helpful assistant. Answer from the projects.' },
      preferredModel: 'e2e-stub',
      enabled: true,
      integrations: { [MCP_INSTALLATION]: {} },
      projects: [{ id: PROJECTS.vendor, mode: 'context' }]
    }
  });
  expect(app.status(), await app.text()).toBe(201);
  // The MCP manager loads the installation in the background.
  await expect
    .poll(
      async () => {
        const res = await admin.get(`/api/integrations/${MCP_INSTALLATION}`);
        return res.ok() ? ((await res.json()).actions || []).map(action => action.name).sort() : [];
      },
      { timeout: 60_000, message: 'the MCP installation lists its tools' }
    )
    .toEqual(['directory_lookup', 'send_email']);
});

test.afterAll(async () => {
  await admin?.delete(`/api/admin/apps/${MCP_APP}`).catch(() => {});
  await admin?.delete(`/api/admin/integrations/installed/${MCP_INSTALLATION}`).catch(() => {});
  await bob?.delete(`/api/scheduled-tasks/${task?.id}`).catch(() => {});
  await admin?.dispose();
  await bob?.dispose();
});

test.beforeEach(async () => {
  await resetModelRequests();
  await resetCanary();
});

test.afterEach(async () => {
  expect(await secretsSeenByModel(), 'secret material in the model context').toEqual([]);
});

test.describe('scheduled tasks', () => {
  test('an injected schedule_task only proposes: no task is created', async () => {
    const before = await bobsTasks();
    const turn = await chatTurn(bob, APPS.actions, 'Set up the vendor sync [inj-schedule]');
    expect(startedTools(turn).map(frame => frame.data.toolId)).toEqual(['schedule_task']);
    const [result] = [...(await toolResultsSeenByModel()).values()].map(r => JSON.parse(r));
    expect(result).toMatchObject({ status: 'proposed', saved: false });
    expect((await bobsTasks()).map(t => t.id)).toEqual(before.map(t => t.id));
  });

  test("an injected delete_scheduled_task only proposes: the user's task stays", async () => {
    const turn = await chatTurn(bob, APPS.actions, 'Clean up my tasks [inj-delete-task]');
    expect(startedTools(turn).map(frame => frame.data.toolId)).toEqual([
      'list_scheduled_tasks',
      'delete_scheduled_task'
    ]);
    // The model aimed at the real task id it listed.
    expect(startedTools(turn)[1].data.args.taskId).toBe(task.id);
    const results = [...(await toolResultsSeenByModel()).values()].map(r => JSON.parse(r));
    expect(results[1]).toMatchObject({ status: 'proposed', saved: false });
    expect((await bobsTasks()).map(t => t.id)).toContain(task.id);
  });

  test("an injected update_scheduled_task only proposes: the task's instructions stay", async () => {
    const turn = await chatTurn(bob, APPS.actions, 'Update my tasks [inj-update-task]');
    expect(startedTools(turn).map(frame => frame.data.toolId)).toEqual([
      'list_scheduled_tasks',
      'update_scheduled_task'
    ]);
    const results = [...(await toolResultsSeenByModel()).values()].map(r => JSON.parse(r));
    expect(results[1]).toMatchObject({ status: 'proposed', saved: false });
    const stored = (await bobsTasks()).find(t => t.id === task.id);
    expect(stored.instructions).toBe('Summarise my week.');
  });
});

test('tools the app does not offer are refused, whatever name the model emits', async () => {
  const before = await bobsTasks();
  await chatTurn(bob, APPS.kb, 'Finish the onboarding [inj-unoffered]');
  const results = [...(await toolResultsSeenByModel()).values()].map(r => JSON.parse(r));
  // schedule_task, write_memory, create_task, write_artifact: none registered here.
  expect(results).toHaveLength(4);
  for (const result of results) {
    expect(result).toMatchObject({ error: true, reason: 'tool_not_registered' });
  }
  expect((await bobsTasks()).map(t => t.id)).toEqual(before.map(t => t.id));
});

test.describe('MCP tools under approval on writes', () => {
  for (const [trigger, tool] of [
    ['inj-mcp-send', 'send_email'],
    ['inj-mcp-lookup', 'directory_lookup']
  ]) {
    test(`${tool}: refused without a person to approve, never sent to the server`, async () => {
      const turn = await chatTurn(bob, MCP_APP, `Forward it to the vendor [${trigger}]`);
      expect(turn.status).toBe(200);
      expect(startedTools(turn)).toEqual([]);
      const results = [...(await toolResultsSeenByModel()).values()].map(r => JSON.parse(r));
      expect(results).toEqual([expect.objectContaining({ code: 'APPROVAL_REQUIRED_NO_USER' })]);
      expect(await toolCalls()).toEqual([]);
    });
  }

  test('in the chat UI: the card waits for the person, and Reject sends nothing', async ({
    page
  }) => {
    await signInPage(page, BOB);
    await sendInUi(page, MCP_APP, 'Forward it to the vendor [inj-mcp-send]');
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    await expect(reject).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('attacker@canary.invalid').filter({ visible: true }).first()
    ).toBeVisible();
    expect(await toolCalls(), 'sent before anyone decided').toEqual([]);

    await reject.click();
    await expect(reject).toBeHidden({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    expect(await toolCalls(), 'sent after the call was rejected').toEqual([]);
  });
});
