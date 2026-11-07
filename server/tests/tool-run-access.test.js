// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who may run a tool directly (`POST /api/tools/:toolId`, `mayRunTool`) now
 * that apps have no `tools` list (#3275): a tool the caller's groups grant
 * (`permissions.tools`), or the tool of an installed integration an app the
 * caller can open binds — through the binding's action list and the group's
 * grant of the installation.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { mayRunTool } from '../routes/toolRoutes.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import { fixtureIntegrationTool, fixtureIntegrations } from './helpers/integrationToolFixture.js';

const platform = { defaultLanguage: 'en', auth: {} };

function user(groups = ['users']) {
  return enhanceUserWithPermissions({ id: 'u', groups, authMode: 'local' }, {}, platform);
}

before(() => {
  configCache.getFeatures = () => ({ skills: false, appAsTool: false });
  configCache.setCacheEntry('config/platform.json', platform);
  configCache.setCacheEntry('config/tools.json', [
    fixtureIntegrationTool('lookup'),
    fixtureIntegrationTool('other')
  ]);
  configCache.setCacheEntry('config/integrations.json', fixtureIntegrations('lookup', 'other'));
  configCache.setCacheEntry('config/apps.json', [
    { id: 'research', enabled: true, integrations: { lookup: {} } },
    { id: 'narrow', enabled: true, integrations: { other: { actions: ['nothing'] } } }
  ]);
  configCache.setCacheEntry('config/groups.json', {
    groups: {
      users: {
        id: 'users',
        permissions: { apps: ['*'], tools: [], integrations: ['lookup', 'other'] }
      },
      granted: {
        id: 'granted',
        permissions: { apps: [], tools: ['other'], integrations: ['lookup', 'other'] }
      },
      blind: { id: 'blind', permissions: { apps: ['*'], tools: [], integrations: [] } }
    }
  });
});

after(() => {
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
});

describe('mayRunTool', () => {
  it('runs the tool of an integration an app the caller can open binds', async () => {
    assert.equal(await mayRunTool(user(), platform, 'lookup'), true);
  });

  it('refuses a tool no app binds and no group grants, and an action the binding leaves out', async () => {
    assert.equal(await mayRunTool(user(), platform, 'other'), false);
  });

  it('refuses the bound tool when the groups do not grant the installation', async () => {
    assert.equal(await mayRunTool(user(['blind']), platform, 'lookup'), false);
  });

  it('runs a tool the caller’s groups grant, without an app', async () => {
    assert.equal(await mayRunTool(user(['granted']), platform, 'other'), true);
    assert.equal(await mayRunTool(user(['granted']), platform, 'lookup'), false);
  });

  it('refuses a tool that does not exist', async () => {
    assert.equal(await mayRunTool(user(), platform, 'missing'), false);
  });
});
