// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';

/**
 * The installations the apps a caller can open bind (`getBoundIntegrationIds`):
 * the keys of `app.integrations`. Apps have no tool list (#3275), and tool
 * grants are gone from groups: the group grant of the installation
 * (`permissions.integrations`) is the only grant.
 */

const appsForUser = { value: [] };

jest.unstable_mockModule('../../configCache.js', () => ({
  resolveEnvVarsInObject: obj => obj,
  default: {
    getAppsForUser: async () => ({ data: appsForUser.value }),
    getPlatform: () => ({ defaultLanguage: 'en' })
  }
}));

const { getBoundIntegrationIds } = await import('../../services/mcp/permissions.js');

const platform = {};

beforeEach(() => {
  appsForUser.value = [];
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
