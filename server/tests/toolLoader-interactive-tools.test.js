#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Interactive clarification tools (`ask_user`, anything `requiresUserInput`)
 * survive a chat's `enabledTools` narrowing in `getToolsForApp` (an app that
 * binds the `ihub` installation).
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
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import a2aClientManager from '../services/a2a/A2aClientManager.js';
import { getToolsForApp } from '../services/tools/appTools.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import {
  FIXTURE_OPEN_GROUPS,
  fixtureInstallation,
  fixtureTool,
  registerFixtureTools,
  unregisterFixtureTools
} from './helpers/integrationToolFixture.js';

configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
// Keep the skills branch out of the way so the offered ids are exactly the
// integration tools under test.
configCache.getFeatures = () => ({ skills: false });
mcpClientManager.listAllTools = async () => [];
a2aClientManager.listAllTools = async () => [];

const ids = list => list.map(t => t.id).sort();

describe('getToolsForApp keeps a bound interactive tool through enabledTools narrowing', () => {
  const user = { id: 'u', groups: ['users'] };

  before(async () => {
    await integrationRegistry.ensureLoaded();
    await registerFixtureTools([fixtureTool('lookup')]);
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        fixtureInstallation('ihub', {
          definition: 'com.intrafind/ihub',
          definitionVersion: integrationRegistry.get('com.intrafind/ihub').definition.version
        }),
        fixtureInstallation('lookup')
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    configCache.setCacheEntry('config/groups.json', { groups: { ...FIXTURE_OPEN_GROUPS } });
  });
  after(() => unregisterFixtureTools());

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
