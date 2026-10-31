// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';

/**
 * Group-level `tools` permission.
 *
 * Tool visibility on the MCP/A2A gateways used to come only from the apps a
 * caller could access, so exposing a tool directly over MCP meant enabling a
 * carrier app whose only job was to hold the permission. `getVisibleToolIds`
 * now unions the group grant with the app-derived set.
 */

const appsForUser = { value: [] };

jest.unstable_mockModule('../../configCache.js', () => ({
  resolveEnvVarsInObject: obj => obj,
  default: {
    getAppsForUser: async () => ({ data: appsForUser.value }),
    getPlatform: () => ({ defaultLanguage: 'en' })
  }
}));

const { getVisibleToolIds, getBoundIntegrationIds, toolVisibleInSet } =
  await import('../../services/mcp/permissions.js');

const platform = {};

beforeEach(() => {
  appsForUser.value = [];
});

describe('getVisibleToolIds', () => {
  it('grants a tool from the group permission with no app involved', async () => {
    const user = { id: 'u1', permissions: { tools: new Set(['iFinder']) } };

    const visible = await getVisibleToolIds(user, platform);

    expect(visible.has('iFinder')).toBe(true);
    // Base-id match covers every function of the tool.
    expect(toolVisibleInSet('iFinder_search', visible)).toBe(true);
    expect(toolVisibleInSet('iFinder_getContent', visible)).toBe(true);
  });

  it('grants a single function when only that function is listed', async () => {
    const user = { id: 'u1', permissions: { tools: new Set(['iFinder_getContent']) } };

    const visible = await getVisibleToolIds(user, platform);

    expect(toolVisibleInSet('iFinder_getContent', visible)).toBe(true);
    expect(toolVisibleInSet('iFinder_search', visible)).toBe(false);
  });

  it('unions the group grant with tools declared by accessible apps', async () => {
    appsForUser.value = [{ id: 'doc-actions', tools: ['jira_searchTickets'] }];
    const user = { id: 'u1', permissions: { tools: new Set(['iFinder']) } };

    const visible = await getVisibleToolIds(user, platform);

    expect(toolVisibleInSet('iFinder_search', visible)).toBe(true);
    expect(toolVisibleInSet('jira_searchTickets', visible)).toBe(true);
  });

  it('stays default-deny when the group grants nothing', async () => {
    const user = { id: 'u1', permissions: { tools: new Set() } };

    const visible = await getVisibleToolIds(user, platform);

    expect(visible.size).toBe(0);
    expect(toolVisibleInSet('iFinder_search', visible)).toBe(false);
  });

  it('tolerates a user with no tools permission at all', async () => {
    appsForUser.value = [{ id: 'doc-actions', tools: ['iFinder_getMetadata'] }];

    const visible = await getVisibleToolIds({ id: 'u1', permissions: {} }, platform);

    expect(toolVisibleInSet('iFinder_getMetadata', visible)).toBe(true);
    expect(toolVisibleInSet('iFinder_search', visible)).toBe(false);
  });

  it('ignores a tools permission that is not a Set', async () => {
    const user = { id: 'u1', permissions: { tools: ['iFinder'] } };

    const visible = await getVisibleToolIds(user, platform);

    expect(visible.size).toBe(0);
  });

  it('honours a wildcard grant', async () => {
    const user = { id: 'u1', permissions: { tools: new Set(['*']) } };

    const visible = await getVisibleToolIds(user, platform);

    expect(toolVisibleInSet('anything', visible)).toBe(true);
  });
});

describe('getBoundIntegrationIds', () => {
  it('collects the installations the accessible apps bind, nothing from tools', async () => {
    appsForUser.value = [
      { id: 'a', tools: ['drawio'], integrations: { github: { actions: ['search'] }, jira: {} } },
      { id: 'b', integrations: { github: {} } },
      { id: 'c', integrations: ['not-an-object'] },
      { id: 'd' }
    ];
    const bound = await getBoundIntegrationIds({ id: 'u', groups: ['users'] }, platform);
    expect([...bound].sort()).toEqual(['github', 'jira']);
  });

  it('is empty when no accessible app binds an installation', async () => {
    appsForUser.value = [{ id: 'a', tools: ['drawio'] }];
    const bound = await getBoundIntegrationIds({ id: 'u', groups: ['users'] }, platform);
    expect(bound.size).toBe(0);
  });
});
