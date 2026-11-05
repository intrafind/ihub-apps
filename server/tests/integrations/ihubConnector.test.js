// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iHub's own chat tools as the always-installed integration `ihub`
 * (`com.intrafind/ihub`): the installation exists whether or not
 * `integrations.json` holds it, cannot be removed or disabled, serves
 * `ask_user` and the scheduled-task tools — and nothing else — under their old
 * ids with their flags, and an app's `tools` list still selects them (exact id
 * or base id, never the installation id). The knowledge tools belong to
 * projects and the agent workspace and evidence tools to workflows and agents:
 * the installation's action switches do not reach them.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../../configCache.js';
import '../../services/integrations/protocols/native/connectors/register.js';
import installedIntegrationService, {
  InstalledIntegrationService
} from '../../services/integrations/InstalledIntegrationService.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import connector, {
  IHUB_TOOL_IDS
} from '../../services/integrations/protocols/native/connectors/ihub/index.js';
import { getToolsForApp } from '../../services/tools/appTools.js';
import { loadTools } from '../../services/tools/catalog.js';
import { isToolSelected } from '../../utils/toolSelection.js';

const everything = { tools: new Set(['*']), apps: new Set(['*']) };
/** The actions the installation keeps (2026-11-01): what users call in chats. */
const KEPT = [
  'ask_user',
  'schedule_task',
  'list_scheduled_tasks',
  'update_scheduled_task',
  'delete_scheduled_task',
  'run_scheduled_task_now',
  'list_task_runs',
  'get_task_run'
];
const member = { id: 'member', groups: ['users'], permissions: everything };

before(async () => {
  await integrationRegistry.ensureLoaded();
  configCache.setCacheEntry('config/tools.json', []);
  configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
  // Members of users may use iHub's own tools (`permissions.integrations`, #3093).
  configCache.setCacheEntry('config/groups.json', {
    groups: { users: { permissions: { integrations: ['ihub'] } } }
  });
  configCache.getFeatures = () => ({ skills: false, appAsTool: false });
  configCache.setCacheEntry('config/integrations.json', {
    installed: [],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
});

after(() => {
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
});

describe('the ihub installation', () => {
  it('is always listed, enabled, even when the file does not hold it', () => {
    const ihub = installedIntegrationService.get('ihub');
    assert.ok(ihub, 'ihub is installed');
    assert.equal(ihub.definition, 'com.intrafind/ihub');
    assert.equal(ihub.enabled, true);
    assert.equal(installedIntegrationService.isAlwaysInstalled('ihub'), true);
    assert.equal(installedIntegrationService.isAlwaysInstalled('brave'), false);
  });

  it('stays enabled when the file says otherwise, and keeps the admin’s action policy', () => {
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        {
          id: 'ihub',
          definition: 'com.intrafind/ihub',
          enabled: false,
          values: {},
          auth: { mode: 'none' },
          actions: { enabled: ['*'], disabled: ['ask_user'], overrides: {} }
        }
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    const ihub = installedIntegrationService.get('ihub');
    assert.equal(ihub.enabled, true);
    assert.deepEqual(ihub.actions.disabled, ['ask_user']);
    configCache.setCacheEntry('config/integrations.json', {
      installed: [],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
  });

  it('refuses to be removed or disabled', async () => {
    await assert.rejects(installedIntegrationService.remove('ihub'), /always installed/);
    await assert.rejects(installedIntegrationService.setEnabled('ihub', false), /always installed/);
  });

  it('is reserved for its definition like every singleton id', async () => {
    const service = new InstalledIntegrationService();
    await assert.rejects(
      service._prepare({ id: 'ihub', definition: 'com.intrafind/brave-search', values: {} }),
      /reserved for com\.intrafind\/ihub/
    );
  });
});

describe('iHub tools', () => {
  it('are exactly ask_user and the scheduled-task tools, under their old ids, with their flags', async () => {
    const tools = await loadTools('en');
    const ihubTools = tools.filter(t => t._integration?.instanceId === 'ihub');
    assert.deepEqual(ihubTools.map(t => t.id).sort(), [...IHUB_TOOL_IDS].sort());
    assert.deepEqual([...IHUB_TOOL_IDS].sort(), [...KEPT].sort());
    assert.deepEqual(
      integrationRegistry
        .get('com.intrafind/ihub')
        .definition.actions.map(a => a.name)
        .sort(),
      [...KEPT].sort()
    );
    const askUser = ihubTools.find(t => t.id === 'ask_user');
    assert.equal(askUser.requiresUserInput, true);
    assert.equal(askUser._integration.fixedToolId, true);
    assert.equal(typeof askUser.description, 'string');
    assert.ok(askUser.parameters.properties.question, 'parameters come from the tool file');
    const deleteTask = ihubTools.find(t => t.id === 'delete_scheduled_task');
    assert.equal(deleteTask.sideEffect, 'destructive');
    assert.equal(deleteTask.readOnly, false);
  });

  it('leaves the knowledge, agent and evidence tools to their features', async () => {
    const tools = await loadTools('en');
    assert.equal(
      tools.some(t => t.id.startsWith('knowledge_')),
      false,
      'the knowledge tools come with projects'
    );
    for (const id of ['write_artifact', 'read_memory', 'evidence_collect']) {
      const tool = tools.find(t => t.id === id);
      assert.ok(tool, `${id} is loaded`);
      assert.equal(tool._integration, undefined, `${id} is not an integration action`);
    }
  });

  it('is selected by its tool id or base id, not by the installation id', async () => {
    const tools = await loadTools('en');
    const askUser = tools.find(t => t.id === 'ask_user');
    assert.equal(isToolSelected({ id: askUser.id }, ['ask_user']), true);
    assert.equal(isToolSelected({ id: askUser.id }, ['schedule_task']), false);
    const offered = await getToolsForApp(
      { id: 'a', tools: ['ask_user', 'knowledge', 'write_artifact'] },
      'en',
      { user: member }
    );
    // `knowledge` selects nothing without a project: the knowledge tools come
    // with the request's projects, not with `tools`.
    assert.deepEqual(offered.map(t => t.id).sort(), ['ask_user', 'write_artifact']);
    // `ihub` itself selects nothing: the installation id is not a tool reference here.
    assert.deepEqual(
      await getToolsForApp({ id: 'b', tools: ['ihub'] }, 'en', { user: member }),
      []
    );
  });

  it('keeps an action switched off in the installation out of the apps, and only its own', async () => {
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        {
          id: 'ihub',
          definition: 'com.intrafind/ihub',
          enabled: true,
          values: {},
          auth: { mode: 'none' },
          // `write_artifact` is not an action any more: a stale entry switches nothing off.
          actions: { enabled: ['*'], disabled: ['ask_user', 'write_artifact'], overrides: {} }
        }
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    try {
      const offered = await getToolsForApp(
        { id: 'a', tools: ['ask_user', 'write_artifact'] },
        'en',
        {
          user: member
        }
      );
      assert.deepEqual(
        offered.map(t => t.id),
        ['write_artifact']
      );
    } finally {
      configCache.setCacheEntry('config/integrations.json', {
        installed: [],
        security: { blockPrivateIps: true, allowedHosts: [] }
      });
    }
  });

  it('tests by loading every implementation', async () => {
    const steps = await connector.test();
    assert.equal(steps.length, KEPT.length);
    assert.deepEqual(
      steps.filter(step => step.status !== 'ok'),
      []
    );
  });
});
