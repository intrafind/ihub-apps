// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, afterEach } from '@jest/globals';

/**
 * The tool listing (`configCache.getToolsForUser`, GET /api/tools?appId=…)
 * lists an installed integration's tools as the chat gets them: the app binds
 * the installation, the user is in its groups and the binding allows the
 * action. The instance id alone grants nothing — except as an explicit group
 * grant in groups.json.
 */

const tools = [
  { id: 'portal__search', _integration: { instanceId: 'portal', action: 'search' } },
  { id: 'portal__purge', _integration: { instanceId: 'portal', action: 'purge' } },
  { id: 'braveSearch' }
];

const instances = {
  portal: { id: 'portal', enabled: true, allowedGroups: ['analysts'] }
};

jest.unstable_mockModule('../../toolLoader.js', () => ({
  loadTools: async () => tools
}));
jest.unstable_mockModule('../../services/integrations/InstalledIntegrationService.js', () => ({
  default: {
    get: id => instances[id] || null,
    resolve: async () => null,
    list: () => Object.values(instances),
    instancesOf: () => []
  }
}));
jest.unstable_mockModule('../../services/integrations/protocols/index.js', () => ({
  getProtocolAdapter: () => null
}));

const { default: configCache } = await import('../../configCache.js');

const originalGetAppsForUser = configCache.getAppsForUser;
afterEach(() => {
  configCache.getAppsForUser = originalGetAppsForUser;
});

const listFor = async ({ app, groups = ['analysts'], grants = [] }) => {
  configCache.getAppsForUser = async () => ({ data: app ? [app] : [] });
  const user = { id: 'u', groups, permissions: { tools: new Set(grants) } };
  const { data } = await configCache.getToolsForUser(user, {}, 'en', { appId: 'chat' });
  return data.map(tool => tool.id).sort();
};

describe('installed integration tools in the tool listing', () => {
  it('lists the actions the binding allows', async () => {
    const app = {
      id: 'chat',
      tools: ['braveSearch'],
      integrations: { portal: { actions: ['search'] } }
    };
    expect(await listFor({ app })).toEqual(['braveSearch', 'portal__search']);
  });

  it('lists every action when the binding names none', async () => {
    const app = { id: 'chat', tools: [], integrations: { portal: {} } };
    expect(await listFor({ app })).toEqual(['portal__purge', 'portal__search']);
  });

  it('lists nothing of an installation whose groups exclude the user', async () => {
    const app = { id: 'chat', tools: ['braveSearch'], integrations: { portal: {} } };
    expect(await listFor({ app, groups: ['guests'] })).toEqual(['braveSearch']);
  });

  it('lists nothing of an installation the app does not bind', async () => {
    const app = { id: 'chat', tools: ['braveSearch', 'portal'] };
    expect(await listFor({ app })).toEqual(['braveSearch']);
  });

  it('keeps an explicit group grant on the instance id', async () => {
    const app = { id: 'chat', tools: [] };
    expect(await listFor({ app, groups: ['guests'], grants: ['portal'] })).toEqual([
      'portal__purge',
      'portal__search'
    ]);
  });
});
