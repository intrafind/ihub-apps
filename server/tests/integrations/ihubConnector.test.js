// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iHub's own tools as the always-installed integration `ihub`
 * (`com.intrafind/ihub`): the installation exists whether or not
 * `integrations.json` holds it, cannot be removed or disabled, serves the
 * tools under their old ids with their flags, and an app's `tools` list
 * still selects them (exact id or base id, never the installation id).
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
import { getToolsForApp, loadTools } from '../../toolLoader.js';
import { isToolSelected } from '../../utils/toolSelection.js';

const everything = { tools: new Set(['*']), apps: new Set(['*']) };
const member = { id: 'member', groups: ['users'], permissions: everything };

before(async () => {
  await integrationRegistry.ensureLoaded();
  configCache.setCacheEntry('config/tools.json', []);
  configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
  configCache.setCacheEntry('config/groups.json', { groups: { users: {} } });
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
    assert.equal(installedIntegrationService.isAlwaysInstalled('websearch'), false);
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
          actions: { enabled: ['*'], disabled: ['ask_user'], overrides: {} },
          allowedGroups: []
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
      service._prepare({ id: 'ihub', definition: 'com.intrafind/web-search', values: {} }),
      /reserved for com\.intrafind\/ihub/
    );
  });
});

describe('iHub tools', () => {
  it('lists every former tool file under its old id, with its flags', async () => {
    const tools = await loadTools('en');
    const ihubTools = tools.filter(t => t._integration?.instanceId === 'ihub');
    assert.deepEqual(ihubTools.map(t => t.id).sort(), [...IHUB_TOOL_IDS].sort());
    assert.equal(ihubTools.length, 22);
    const askUser = ihubTools.find(t => t.id === 'ask_user');
    assert.equal(askUser.requiresUserInput, true);
    assert.equal(askUser._integration.fixedToolId, true);
    assert.equal(typeof askUser.description, 'string');
    assert.ok(askUser.parameters.properties.question, 'parameters come from the tool file');
    const collect = ihubTools.find(t => t.id === 'evidence_collect');
    assert.ok(collect.parameters.properties.extraction);
    assert.equal(typeof collect.parameters.properties.extraction.description, 'string');
    const writeMemory = ihubTools.find(t => t.id === 'write_memory');
    assert.equal(writeMemory.sideEffect, 'write');
    assert.equal(writeMemory.readOnly, false);
    assert.equal(writeMemory.isAgentTool, true);
  });

  it('is selected by its tool id or base id, not by the installation id', async () => {
    const tools = await loadTools('en');
    const search = tools.find(t => t.id === 'knowledge_search');
    assert.equal(isToolSelected(search, ['knowledge']), true);
    assert.equal(isToolSelected(search, ['knowledge_search']), true);
    assert.equal(isToolSelected(search, ['ask_user']), false);
    const offered = await getToolsForApp(
      { id: 'a', tools: ['ask_user', 'knowledge', 'write_artifact'] },
      'en',
      { user: member }
    );
    assert.deepEqual(offered.map(t => t.id).sort(), [
      'ask_user',
      'knowledge_list',
      'knowledge_read',
      'knowledge_search',
      'write_artifact'
    ]);
    // `ihub` itself selects nothing: the installation id is not a tool reference here.
    assert.deepEqual(
      await getToolsForApp({ id: 'b', tools: ['ihub'] }, 'en', { user: member }),
      []
    );
  });

  it('keeps an action switched off in the installation out of the apps', async () => {
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        {
          id: 'ihub',
          definition: 'com.intrafind/ihub',
          enabled: true,
          values: {},
          auth: { mode: 'none' },
          actions: { enabled: ['*'], disabled: ['write_artifact'], overrides: {} },
          allowedGroups: []
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
        ['ask_user']
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
    assert.equal(steps.length, 22);
    assert.deepEqual(
      steps.filter(step => step.status !== 'ok'),
      []
    );
  });
});
