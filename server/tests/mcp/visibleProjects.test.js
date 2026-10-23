// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP resource paths list and read the projects that the caller's apps
 * link (`getVisibleProjectIds`). While the Projects feature is off, that set
 * is empty, so neither path reaches project documents through an app that
 * does not itself require the feature.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let features = {};
const apps = [
  { id: 'support', projects: ['faq', { id: 'handbook', mode: 'tools' }] },
  { id: 'chat', projects: [] },
  // Projects switched off for the app: its links stay stored but grant nothing.
  { id: 'dark', projects: ['secret'], features: { projects: false } }
];

jest.unstable_mockModule('../../configCache.js', () => ({
  __esModule: true,
  default: {
    getFeatures: () => features,
    getAppsForUser: async () => ({ data: apps })
  }
}));

const { getVisibleProjectIds } = await import('../../services/mcp/permissions.js');

const USER = { id: 'user-ada', groups: ['authenticated'] };

describe('mcp/permissions getVisibleProjectIds', () => {
  beforeEach(() => {
    features = {};
  });

  it('collects the projects the accessible apps link', async () => {
    features = { projects: true };
    expect([...(await getVisibleProjectIds(USER, {}))].sort()).toEqual(['faq', 'handbook']);
  });

  it('skips the links of an app that switched projects off', async () => {
    features = { projects: true };
    expect((await getVisibleProjectIds(USER, {})).has('secret')).toBe(false);
  });

  it('is empty while the Projects feature is off', async () => {
    features = { projects: false };
    expect((await getVisibleProjectIds(USER, {})).size).toBe(0);
  });
});
