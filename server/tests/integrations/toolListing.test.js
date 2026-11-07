// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, afterEach } from '@jest/globals';

/**
 * The tool listing (`getToolsForUser`, GET /api/tools?appId=…)
 * lists an installed integration's tools as the chat gets them: the app binds
 * the installation, the user's groups grant it (`permissions.integrations`,
 * #3093) and the binding allows the action. The instance id alone grants
 * nothing — except as an explicit tool grant in groups.json.
 */

const tools = [
  { id: 'portal__search', _integration: { instanceId: 'portal', action: 'search' } },
  { id: 'portal__purge', _integration: { instanceId: 'portal', action: 'purge' } },
  { id: 'braveSearch' }
];

const instances = {
  portal: { id: 'portal', definition: 'com.example/portal', enabled: true }
};

/** What each group's `permissions.integrations` grants, as the enhanced user carries it. */
const INTEGRATION_GRANTS = { analysts: ['portal'], guests: [] };

jest.unstable_mockModule('../../services/tools/catalog.js', () => ({
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
const { getToolsForUser } = await import('../../services/tools/toolListing.js');

const originalGetAppsForUser = configCache.getAppsForUser;
afterEach(() => {
  configCache.getAppsForUser = originalGetAppsForUser;
});

const listFor = async ({ app, groups = ['analysts'], grants = [] }) => {
  configCache.getAppsForUser = async () => ({ data: app ? [app] : [] });
  const user = {
    id: 'u',
    groups,
    permissions: {
      tools: new Set(grants),
      integrations: new Set(groups.flatMap(group => INTEGRATION_GRANTS[group] || []))
    }
  };
  const { data } = await getToolsForUser(user, {}, 'en', { appId: 'chat' });
  return data.map(tool => tool.id).sort();
};

describe('installed integration tools in the tool listing', () => {
  it('lists the actions the binding allows', async () => {
    const app = { id: 'chat', integrations: { portal: { actions: ['search'] } } };
    expect(await listFor({ app })).toEqual(['portal__search']);
  });

  it('lists every action when the binding names none', async () => {
    const app = { id: 'chat', integrations: { portal: {} } };
    expect(await listFor({ app })).toEqual(['portal__purge', 'portal__search']);
  });

  it("lists nothing of an installation the user's groups do not grant", async () => {
    const app = { id: 'chat', integrations: { portal: {} } };
    expect(await listFor({ app, groups: ['guests'] })).toEqual([]);
  });

  it('lists nothing of an installation the app does not bind, whatever a leftover `tools` names', async () => {
    const app = { id: 'chat', tools: ['braveSearch', 'portal'] };
    expect(await listFor({ app })).toEqual([]);
  });

  it('keeps an explicit tool grant on the instance id for a user whose groups grant the installation', async () => {
    const app = { id: 'chat' };
    expect(await listFor({ app, groups: ['analysts'], grants: ['portal'] })).toEqual([
      'portal__purge',
      'portal__search'
    ]);
  });

  it('lists nothing for a tool grant holder whose groups do not grant the installation', async () => {
    const app = { id: 'chat' };
    expect(await listFor({ app, groups: ['guests'], grants: ['portal'] })).toEqual([]);
    expect(await listFor({ app, groups: ['guests'], grants: ['*'] })).toEqual(['braveSearch']);
  });
});
