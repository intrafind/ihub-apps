// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * The installed-integrations reload hook feeds the A2A (and MCP) client
 * managers in cluster mode. The worker that serves an admin save re-applies
 * inline and moves its watcher baseline with `markConfigApplied`; otherwise an
 * A→B (here) then B→A (another worker) sequence would compare equal to the
 * stale baseline A and leave this worker on B.
 */

const cache = { integrations: null };
let hook = null;

jest.unstable_mockModule('../../configSync.js', () => ({
  ALL_ENTRIES: '*',
  registerConfigChangeHook: fn => {
    hook = fn;
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getIntegrations: () => ({ data: structuredClone(cache.integrations) })
  }
}));
const initializeA2a = jest.fn(async () => {});
const initializeMcp = jest.fn(async () => {});
jest.unstable_mockModule('../../services/integrations/protocols/a2a/manager.js', () => ({
  initializeA2aFromInstallations: initializeA2a
}));
jest.unstable_mockModule('../../services/integrations/protocols/mcp/manager.js', () => ({
  initializeMcpFromInstallations: initializeMcp
}));
for (const mod of [
  '../../services/integrations/protocols/openapi/OpenApiAdapter.js',
  '../../services/integrations/protocols/native/NativeAdapter.js'
]) {
  jest.unstable_mockModule(mod, () => ({ invalidate: () => {} }));
}
jest.unstable_mockModule('../../services/integrations/integrationTools.js', () => ({
  syncIntegrationScopeProviders: async () => {}
}));
for (const mod of [
  '../../services/integrations/iAssistantService.js',
  '../../services/integrations/iFinderService.js',
  '../../services/integrations/iAssistantProfileResolver.js'
]) {
  jest.unstable_mockModule(mod, () => ({
    default: { resetConfig: () => {}, reset: () => {}, clear: () => {}, invalidate: () => {} }
  }));
}
jest.unstable_mockModule('../../services/integrations/iFinderTokenProvider.js', () => ({
  default: { clearExchangedTokens: () => {}, reset: () => {} },
  clearExchangedTokenCache: () => {}
}));

const { registerConfigReloadHooks, markConfigApplied, resetConfigReloadHooksForTests } =
  await import('../../configReloadHooks.js');

const A = { installed: [{ id: 'x', definition: 'com.intrafind/a2a-agent', enabled: true }] };
const B = { installed: [{ id: 'x', definition: 'com.intrafind/a2a-agent', enabled: false }] };
const ENTRY = 'config/integrations.json';

beforeEach(() => {
  resetConfigReloadHooksForTests();
  initializeA2a.mockClear();
  initializeMcp.mockClear();
  cache.integrations = structuredClone(A);
  registerConfigReloadHooks();
});

describe('installed integrations reload hook', () => {
  it('re-applies A→B→A on the worker that served the first change', async () => {
    cache.integrations = structuredClone(B);
    markConfigApplied(ENTRY);
    cache.integrations = structuredClone(A);
    await hook({ entries: [ENTRY] });
    expect(initializeA2a).toHaveBeenCalledTimes(1);
    expect(initializeMcp).toHaveBeenCalledTimes(1);
  });

  it('skips an announcement that changes nothing for this worker', async () => {
    cache.integrations = structuredClone(B);
    markConfigApplied(ENTRY);
    await hook({ entries: [ENTRY] });
    expect(initializeA2a).not.toHaveBeenCalled();
  });
});
