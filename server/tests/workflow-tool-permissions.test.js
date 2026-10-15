#!/usr/bin/env node

/**
 * An app's model may only run a workflow the person who chats may run.
 *
 * The model acts for the user of the chat. Before this, a workflow with
 * `chatIntegration.enabled` was offered to the model of every app that lists it
 * and run for whoever chatted, whatever `permissions.workflows` said: only the
 * `@mention` path asked the user's groups. These tests pin the rule in both
 * places that hold it — the tools the model is offered (`getToolsForApp`) and
 * the runner every start goes through (`runTool` → `workflowRunner`), which is
 * what stops a call the model was never offered.
 *
 * Run: node --test server/tests/workflow-tool-permissions.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import a2aClientManager from '../services/a2a/A2aClientManager.js';
import { getToolsForApp, runTool } from '../toolLoader.js';
import { runnerAccess } from '../services/workflow/workflowAccess.js';

const WORKFLOW_ID = 'summarize-report';
const TOOL_ID = `workflow_${WORKFLOW_ID}`;

/** Offered in chat; it has no steps, so a run that is let through fails to start, which is all these tests need. */
const WORKFLOW = {
  id: WORKFLOW_ID,
  name: { en: 'Summarize report' },
  description: { en: 'Summarizes a report.' },
  enabled: true,
  chatIntegration: { enabled: true },
  nodes: [],
  edges: []
};

const APP = { id: 'chat', workflows: [WORKFLOW_ID] };

const PERMITTED = { id: 'user-1', permissions: { workflows: new Set([WORKFLOW_ID]) } };
const WILDCARD = { id: 'user-2', permissions: { workflows: new Set(['*']) } };
const OTHER_WORKFLOW_ONLY = { id: 'user-3', permissions: { workflows: new Set(['other']) } };
const NO_PERMISSIONS = { id: 'user-4', permissions: { workflows: new Set() } };
const ADMIN = { id: 'admin-1', groups: ['admin'], permissions: { adminAccess: true } };
const ANONYMOUS = { id: 'anonymous', groups: ['admin'], permissions: { workflows: new Set() } };

configCache.getTools = () => ({ data: [] });
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
configCache.getFeatures = () => ({ skills: false });
mcpClientManager.listAllTools = async () => [];
a2aClientManager.listAllTools = async () => [];

function serve(workflow) {
  configCache.setCacheEntry('config/workflows.json', workflow ? [workflow] : []);
}

const offeredIds = async (user, app = APP) =>
  (await getToolsForApp(app, 'en', { user })).map(tool => tool.id);

describe('runnerAccess', () => {
  it('lets a user whose groups grant the workflow run it', () => {
    assert.equal(runnerAccess({ user: PERMITTED, workflow: WORKFLOW }), true);
    assert.equal(runnerAccess({ user: WILDCARD, workflow: WORKFLOW }), true);
  });

  it('lets an admin run any workflow', () => {
    assert.equal(runnerAccess({ user: ADMIN, workflow: WORKFLOW }), true);
  });

  it('refuses a user whose groups grant other workflows, or none', () => {
    assert.equal(runnerAccess({ user: OTHER_WORKFLOW_ONLY, workflow: WORKFLOW }), false);
    assert.equal(runnerAccess({ user: NO_PERMISSIONS, workflow: WORKFLOW }), false);
  });

  it('refuses a call that carries no user', () => {
    assert.equal(runnerAccess({ user: undefined, workflow: WORKFLOW }), false);
    assert.equal(runnerAccess({ user: null, app: APP, workflow: WORKFLOW }), false);
  });

  it('never treats the anonymous principal as an admin, whatever groups it carries', () => {
    assert.equal(runnerAccess({ user: ANONYMOUS, workflow: WORKFLOW }), false);
  });

  it('inside an app also needs the app to list the workflow', () => {
    assert.equal(runnerAccess({ user: PERMITTED, app: APP, workflow: WORKFLOW }), true);
    assert.equal(
      runnerAccess({ user: PERMITTED, app: { id: 'chat', workflows: [] }, workflow: WORKFLOW }),
      false
    );
    assert.equal(runnerAccess({ user: PERMITTED, app: { id: 'chat' }, workflow: WORKFLOW }), false);
  });

  it('inside an app a listed workflow is still refused to a user who may not run it', () => {
    assert.equal(runnerAccess({ user: NO_PERMISSIONS, app: APP, workflow: WORKFLOW }), false);
  });
});

describe('the workflow tools an app offers its model', () => {
  beforeEach(() => serve(WORKFLOW));
  afterEach(() => serve(null));

  it('offers the workflow to a user who may run it', async () => {
    assert.deepEqual(await offeredIds(PERMITTED), [TOOL_ID]);
    assert.deepEqual(await offeredIds(WILDCARD), [TOOL_ID]);
    assert.deepEqual(await offeredIds(ADMIN), [TOOL_ID]);
  });

  it('does not offer it to a user who may not', async () => {
    assert.deepEqual(await offeredIds(NO_PERMISSIONS), []);
    assert.deepEqual(await offeredIds(OTHER_WORKFLOW_ONLY), []);
    assert.deepEqual(await offeredIds(ANONYMOUS), []);
  });

  it('does not offer it when the call carries no user', async () => {
    assert.deepEqual(await offeredIds(undefined), []);
  });

  it('keeps offering only workflows with chat integration on', async () => {
    serve({ ...WORKFLOW, chatIntegration: { enabled: false } });
    assert.deepEqual(await offeredIds(PERMITTED), []);
  });

  it('offers a permitted user only the workflows the app lists', async () => {
    assert.deepEqual(await offeredIds(PERMITTED, { id: 'chat', workflows: [] }), []);
  });
});

describe('running a workflow tool', () => {
  beforeEach(() => serve(WORKFLOW));
  afterEach(() => serve(null));

  it('refuses a user who may not run the workflow, even for a call the model was never offered', async () => {
    await assert.rejects(
      runTool(TOOL_ID, { user: NO_PERMISSIONS, appConfig: APP, chatId: 'c1' }),
      /Workflow 'summarize-report' not found/
    );
    await assert.rejects(
      runTool(TOOL_ID, { user: OTHER_WORKFLOW_ONLY, chatId: 'c1' }),
      /Workflow 'summarize-report' not found/
    );
  });

  it('refuses a call that carries no user', async () => {
    await assert.rejects(runTool(TOOL_ID, { chatId: 'c1' }), /not found/);
  });

  it('answers a refusal like a workflow that does not exist, so it confirms nothing', async () => {
    serve({ ...WORKFLOW, enabled: false });
    await assert.rejects(
      runTool(TOOL_ID, { user: NO_PERMISSIONS, appConfig: APP }),
      /Workflow 'summarize-report' not found/
    );
    await assert.rejects(
      runTool('workflow_missing', { user: PERMITTED, appConfig: APP }),
      /Workflow 'missing' not found/
    );
  });

  it('refuses a permitted user inside an app that does not list the workflow', async () => {
    await assert.rejects(
      runTool(TOOL_ID, { user: PERMITTED, appConfig: { id: 'chat', workflows: [] } }),
      /not found/
    );
  });

  it('gets a permitted user past the check', async () => {
    // The workflow has no steps, so the run fails to start — but it is the
    // run that fails, not the permission check.
    const result = await runTool(TOOL_ID, { user: PERMITTED, appConfig: APP, chatId: 'c1' });
    assert.equal(result?.status, 'error');
    assert.doesNotMatch(String(result?.error), /not found/);
  });

  it('tells a permitted user who runs a disabled workflow that it is disabled', async () => {
    serve({ ...WORKFLOW, enabled: false });
    await assert.rejects(
      runTool(TOOL_ID, { user: PERMITTED, appConfig: APP }),
      /Workflow 'summarize-report' is disabled/
    );
  });
});
