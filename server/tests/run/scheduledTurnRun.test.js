// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A scheduled run on the run service, driven through the scheduler itself
 * (`taskExecution.executeTaskRun`), not through a spec the test builds: the
 * run spec `taskExecution.js` hands the chat host carries the run context of
 * a scheduled run (origin `schedule`, unattended, approvals for the owner, the
 * task and the run), a tool call outside the run's grant is refused and
 * audited under the scheduled run, and the task editor offers exactly the
 * tools a run gets (no admin rights, so no workflow the owner's groups do not
 * grant).
 *
 * The scheduled-task test files pin what a run does; this file pins what it
 * runs as. Only the model is scripted (`helpers/scheduledTaskHarness.js`).
 *
 * Run: node --test server/tests/run/scheduledTurnRun.test.js
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../../configCache.js';
import {
  APPS,
  cleanup,
  harnessIntegrations,
  principal,
  scriptedChatService,
  setPlatform,
  setupHarness,
  taskInput,
  teardownHarness,
  toolCall
} from '../helpers/scheduledTaskHarness.js';
import { openaiText } from '../loop/helpers/llmFixtures.js';
import * as tasks from '../../services/scheduler/tasks/taskService.js';
import * as taskExecution from '../../services/scheduler/tasks/taskExecution.js';
import { RunService } from '../../services/run/RunService.js';
import { isRunContext } from '../../services/run/RunContext.js';
import { TOOL_REFUSAL_CODES } from '../../services/run/ToolRunner.js';
import { queryAuditLog } from '../../services/AuditLogService.js';

/** A workflow the app `digest` lists, which no group of the harness grants. */
const WORKFLOW = {
  id: 'check',
  name: { en: 'Installation check' },
  description: { en: 'Checks the installation' },
  enabled: true,
  chatIntegration: { enabled: true },
  nodes: [{ id: 'start', type: 'start', config: {} }]
};

before(async () => {
  await setupHarness({
    apps: APPS.map(app => (app.id === 'digest' ? { ...app, workflows: [WORKFLOW.id] } : app))
  });
  configCache.setCacheEntry('config/workflows.json', [WORKFLOW]);
});

after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });

/** An admin owner, as `enhanceUserWithPermissions` marks one. */
function admin() {
  const user = principal({ id: 'user-root', name: 'Root' });
  return {
    ...user,
    isAdmin: true,
    isContentAdmin: true,
    permissions: { ...user.permissions, adminAccess: true, contentAdmin: true }
  };
}

/** Capture the specs the chat host hands the run service. */
function captureSpecs(t) {
  t.after(() => mock.restoreAll());
  const specs = [];
  const original = RunService.prototype.run;
  mock.method(RunService.prototype, 'run', function (spec, host) {
    specs.push(spec);
    return original.call(this, spec, host);
  });
  return specs;
}

/** Queue a run of a new task of Ada's and execute it through the scheduler. */
async function runTask(script, options = {}) {
  const task = await tasks.createTask(ada(), taskInput());
  const queued = await tasks.requestRun(ada(), task.id);
  const chat = scriptedChatService(script, options);
  const done = await taskExecution.executeTaskRun({ taskId: task.id, runId: queued.id }, chat.deps);
  return { task, queued, done, chat };
}

describe('a scheduled run, executed by the scheduler, on the run service', () => {
  it('runs in the context of a scheduled run: origin schedule, unattended, approvals for the owner', async t => {
    const specs = captureSpecs(t);
    const { task, queued, done } = await runTask([openaiText(['All quiet today.'])]);
    assert.equal(done.status, 'succeeded');
    assert.equal(specs.length, 1);
    const [spec] = specs;
    assert.equal(spec.kind, 'turn');
    assert.equal(spec.caller, 'schedule');
    assert.ok(isRunContext(spec.context));
    assert.equal(spec.context.origin, 'schedule');
    assert.equal(spec.context.unattended, true);
    assert.equal(spec.context.approvalRoute, 'owner');
    assert.deepEqual({ ...spec.context.schedule }, { taskId: task.id, runId: queued.id });
    assert.deepEqual(
      { ...spec.context.principal.scheduledRun },
      { taskId: task.id, runId: queued.id }
    );
    assert.equal(spec.context.principal.id, 'user-ada');
    await cleanup(ada());
  });

  it('refuses a tool call outside the grant and audits it under the scheduled run', async t => {
    const specs = captureSpecs(t);
    const since = new Date().toISOString();
    t.after(() => configCache.setCacheEntry('config/integrations.json', harnessIntegrations()));
    let calls = 0;
    const ran = [];
    const { done, chat } = await runTask(
      [toolCall('lookup', { key: 'A-1' }), openaiText(['I could not look it up.'])],
      {
        // The installation is disabled after the run was granted its tools.
        onRequest: () => {
          calls += 1;
          if (calls !== 1) return;
          const integrations = harnessIntegrations();
          configCache.setCacheEntry('config/integrations.json', {
            ...integrations,
            installed: integrations.installed.map(instance =>
              instance.id === 'lookup' ? { ...instance, enabled: false } : instance
            )
          });
        },
        runTool: async toolId => {
          ran.push(toolId);
          return { ok: true };
        }
      }
    );
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(ran, [], 'the refused tool never ran');
    const toolMessage = chat.requests[1].body.messages.find(message => message.role === 'tool');
    assert.match(toolMessage.content, /not permitted for this caller/);
    const { entries } = await queryAuditLog({ resource: 'tool', result: 'failure', limit: 50 });
    const refusals = entries.filter(e => e.ts >= since && e.resourceId === 'lookup');
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].details.code, TOOL_REFUSAL_CODES.NOT_GRANTED);
    assert.equal(refusals[0].details.runId, specs[0].runId);
    assert.equal(refusals[0].details.origin, 'schedule');
    assert.equal(refusals[0].source, 'schedule');
    assert.equal(refusals[0].actor.id, 'user-ada');
    await cleanup(ada());
  });
});

describe('the task editor offers the tools a scheduled run gets', () => {
  const app = () => configCache.getApps(true).data.find(entry => entry.id === 'digest');
  const ids = async user => (await tasks.toolsOfferedByApp(app(), user, 'en')).map(tool => tool.id);

  it('offers an admin no workflow the run could not start, and refuses to save one', async t => {
    t.after(() => setPlatform({}));
    const offered = await ids(admin());
    assert.ok(offered.includes('lookup'), 'the tools of the groups are offered');
    assert.ok(!offered.includes(`workflow_${WORKFLOW.id}`), 'no workflow from admin rights');
    await assert.rejects(
      tasks.createTask(admin(), taskInput({ enabledTools: ['lookup', `workflow_${WORKFLOW.id}`] })),
      error => {
        assert.match(JSON.stringify(error), /does not offer these tools to a scheduled run/);
        return true;
      }
    );
    // With the kill switch off a scheduled run keeps the admin rights, and so does the editor.
    setPlatform({ runs: { chatOnRunService: false } });
    assert.ok((await ids(admin())).includes(`workflow_${WORKFLOW.id}`));
    await cleanup(admin());
  });
});
