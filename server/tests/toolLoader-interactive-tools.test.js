#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Interactive clarification tools (`ask_user`, anything `requiresUserInput`)
 * survive a chat's `enabledTools` narrowing in `getToolsForApp` (an app that
 * binds the `ihub` installation) and `getToolsForNode` (a workflow node that
 * names one).
 *
 * They are a system channel the agent loop drives to pause a turn and ask the
 * user a question — not a user-selectable capability. An app that binds one
 * must keep it whatever the per-chat toggle (or a stale saved selection that
 * predates the tool) says, or the model loses its only way to ask and the
 * interview loops instead of pausing. These tests pin that: the narrowing
 * still removes ordinary tools, and never the interactive one, while an app
 * that does not grant it never has it injected.
 *
 * Run: node --test server/tests/toolLoader-interactive-tools.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import a2aClientManager from '../services/a2a/A2aClientManager.js';
import { getToolsForApp, getToolsForNode } from '../services/tools/appTools.js';
import {
  FIXTURE_OPEN_GROUPS,
  fixtureInstallation,
  fixtureIntegrationTool
} from './helpers/integrationToolFixture.js';

const askUser = {
  id: 'ask_user',
  requiresUserInput: true,
  name: { en: 'Ask User for Clarification' },
  description: { en: 'Ask the user a clarifying question.' },
  parameters: { type: 'object', properties: {}, required: [] }
};
const customInteractive = {
  id: 'custom_prompt',
  requiresUserInput: true,
  name: { en: 'Custom Prompt' },
  description: { en: 'Another interactive tool.' },
  parameters: { type: 'object', properties: {}, required: [] }
};
const braveSearch = {
  id: 'braveSearch',
  name: { en: 'Brave Search' },
  description: { en: 'Search the web.' },
  parameters: { type: 'object', properties: {}, required: [] }
};

let tools = [];
configCache.getTools = () => ({ data: tools });
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
// Keep the skills branch out of the way so the offered ids are exactly the
// configured tools under test.
configCache.getFeatures = () => ({ skills: false });
mcpClientManager.listAllTools = async () => [];
a2aClientManager.listAllTools = async () => [];

const ids = list => list.map(t => t.id).sort();

describe('getToolsForNode keeps interactive tools through enabledTools narrowing', () => {
  beforeEach(() => {
    tools = [askUser, customInteractive, braveSearch];
  });

  it('keeps ask_user when the chat enables no tools at all', async () => {
    const offered = await getToolsForNode(['ask_user', 'braveSearch'], { id: 'builder' }, 'en', {
      enabledTools: []
    });
    assert.deepEqual(ids(offered), ['ask_user']);
  });

  it('keeps ask_user alongside the ordinary tools the chat does enable', async () => {
    const offered = await getToolsForNode(['ask_user', 'braveSearch'], { id: 'builder' }, 'en', {
      enabledTools: ['braveSearch']
    });
    assert.deepEqual(ids(offered), ['ask_user', 'braveSearch']);
  });

  it('keeps any requiresUserInput tool the node names, not only ask_user', async () => {
    const offered = await getToolsForNode(
      ['custom_prompt', 'braveSearch'],
      { id: 'builder' },
      'en',
      { enabledTools: [] }
    );
    assert.deepEqual(ids(offered), ['custom_prompt']);
  });

  it('never injects an interactive tool the node does not name', async () => {
    const offered = await getToolsForNode(['braveSearch'], { id: 'builder' }, 'en', {
      enabledTools: ['braveSearch']
    });
    assert.deepEqual(ids(offered), ['braveSearch']);
  });

  it('still removes an ordinary tool the chat did not enable', async () => {
    const offered = await getToolsForNode(['ask_user', 'braveSearch'], { id: 'builder' }, 'en', {
      enabledTools: ['ask_user']
    });
    assert.deepEqual(ids(offered), ['ask_user']);
  });
});

describe('getToolsForApp keeps a bound interactive tool through enabledTools narrowing', () => {
  const user = { id: 'u', groups: ['users'] };
  const interactive = fixtureIntegrationTool('ask_user', {
    requiresUserInput: true,
    _integration: { instanceId: 'ihub', definition: 'com.intrafind/ihub', fixedToolId: true }
  });
  const ordinary = fixtureIntegrationTool('lookup');

  beforeEach(() => {
    tools = [interactive, ordinary];
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        fixtureInstallation('ihub', { definition: 'com.intrafind/ihub' }),
        fixtureInstallation('lookup')
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    configCache.setCacheEntry('config/groups.json', { groups: { ...FIXTURE_OPEN_GROUPS } });
  });

  const app = {
    id: 'builder',
    integrations: { ihub: { actions: ['ask_user'] }, lookup: {} }
  };

  it('keeps ask_user when the chat enables no tools at all', async () => {
    const offered = await getToolsForApp(app, 'en', { user, enabledTools: [] });
    assert.deepEqual(ids(offered), ['ask_user']);
  });

  it('keeps ask_user alongside the ordinary tools the chat does enable', async () => {
    const offered = await getToolsForApp(app, 'en', { user, enabledTools: ['lookup'] });
    assert.deepEqual(ids(offered), ['ask_user', 'lookup']);
  });

  it('offers nothing for a leftover `tools` list', async () => {
    const offered = await getToolsForApp({ id: 'old', tools: ['ask_user', 'lookup'] }, 'en', {
      user
    });
    assert.deepEqual(ids(offered), []);
  });
});
