// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Headless runs and integration connections: a scheduled run uses the task
 * **owner's** own connections — never anybody else's. A run is not refused up
 * front because the app offers a tool whose integration the owner has not
 * connected (most runs never call most of the app's tools); a tool that does
 * need the connection returns the structured `INTEGRATION_AUTH_REQUIRED`
 * result when it is called, and the run ends with that code, naming the
 * integration and the reason.
 *
 * Run: node --test server/tests/scheduled-tasks-integration-auth.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanup,
  principal,
  scriptedChatService,
  setupHarness,
  taskInput,
  teardownHarness,
  toolCall
} from './helpers/scheduledTaskHarness.js';
import { openaiText } from './loop/helpers/llmFixtures.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import * as taskExecution from '../services/scheduler/tasks/taskExecution.js';
import { integrationIssueOf } from '../services/scheduler/tasks/runSeams.js';
import { integrationAuthRequiredResult } from '../services/integrations/auth/integrationAuthRequired.js';

before(() => setupHarness());
after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });

async function run(script, runTool) {
  const task = await tasks.createTask(ada(), taskInput());
  const queued = await tasks.requestRun(ada(), task.id);
  const chat = scriptedChatService(script, { runTool });
  return taskExecution.executeTaskRun({ taskId: task.id, runId: queued.id }, chat.deps);
}

describe('scheduled runs and integration connections', () => {
  it('has no up-front check that fails runs for tools they never call', async () => {
    assert.equal(taskExecution.checkIntegrations, undefined);
    const done = await run([openaiText(['All quiet today.'])], async () => {
      throw new Error('no tool should run');
    });
    assert.equal(done.status, 'succeeded');
    await cleanup(ada());
  });

  it("runs a tool as the owner and ends with INTEGRATION_AUTH_REQUIRED when the owner's connection is missing", async () => {
    const calls = [];
    const failed = await run(
      [toolCall('lookup', { key: 'x' }), openaiText(['Sorry, I could not look it up.'])],
      async (toolId, params) => {
        calls.push({ toolId, user: params?.user?.id });
        return integrationAuthRequiredResult({
          integration: 'jira',
          reason: 'not_connected',
          message: 'Please connect your JIRA account to search tickets',
          connectUrl: '/api/integrations/jira/connect'
        });
      }
    );
    assert.deepEqual(calls, [{ toolId: 'lookup', user: 'user-ada' }], 'the owner, nobody else');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason.code, 'INTEGRATION_AUTH_REQUIRED');
    assert.equal(failed.reason.integration, 'jira');
    assert.equal(failed.reason.reason, 'not_connected');
    // The run page links the owner to Settings → Integrations (a page), not to
    // the connect API route the tool result names.
    assert.equal(failed.reason.connectUrl, '/settings/integrations');
    await cleanup(ada());
  });
});

describe('what a tool result says about its integration', () => {
  it('reads the structured INTEGRATION_AUTH_REQUIRED result', () => {
    assert.deepEqual(
      integrationIssueOf('jira_searchTickets', {
        error: 'INTEGRATION_AUTH_REQUIRED',
        integration: 'jira',
        reason: 'not_connected',
        message: 'Please connect your JIRA account to search tickets',
        connectUrl: '/api/integrations/jira/connect'
      }),
      {
        toolId: 'jira_searchTickets',
        message: 'Please connect your JIRA account to search tickets',
        integration: 'jira',
        reason: 'not_connected',
        connectUrl: '/api/integrations/jira/connect'
      }
    );
  });

  it('keeps the MCP Connect marker and adds the structured fields', () => {
    const issue = integrationIssueOf('okta__whoami', {
      error: 'INTEGRATION_AUTH_REQUIRED',
      integration: 'okta',
      reason: 'expired',
      authRequired: { serverId: 'okta', serverName: 'Okta', connectUrl: '/connect' }
    });
    assert.deepEqual(issue, {
      toolId: 'okta__whoami',
      message: 'Connect Okta again',
      integration: 'okta',
      reason: 'expired',
      connectUrl: '/connect'
    });
  });
});
