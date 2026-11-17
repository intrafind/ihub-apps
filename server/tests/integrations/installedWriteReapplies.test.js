// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * The worker that writes `config/integrations.json` re-applies the
 * config-derived runtime state itself (the MCP and A2A client managers, the
 * adapter caches): the other workers do it on the announcement, but the
 * announcement never reaches the sender. Without this, one request in N
 * (N workers; every request with one worker) saw an MCP installation
 * that did not exist yet, with no tools and no way to connect.
 */

const order = [];
const applyConfigReloadHooks = jest.fn(async () => {
  order.push('apply');
});
jest.unstable_mockModule('../../configReloadHooks.js', () => ({ applyConfigReloadHooks }));
const refreshCacheEntry = jest.fn(async () => {
  order.push('refresh');
});
jest.unstable_mockModule('../../configCache.js', () => ({
  default: { refreshCacheEntry, get: () => ({ data: { installed: [] } }) }
}));
const updateJson = jest.fn(async (_file, change) => {
  change({ installed: [] });
  order.push('write');
  return { written: true };
});
jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: { updateJson, writeJson: jest.fn(async () => order.push('write')) }
}));

const { InstalledIntegrationService, INTEGRATIONS_FILE } =
  await import('../../services/integrations/InstalledIntegrationService.js');

beforeEach(() => {
  order.length = 0;
  applyConfigReloadHooks.mockClear();
});

describe('InstalledIntegrationService writes', () => {
  it('re-applies on this worker after the cache has the new file', async () => {
    const service = new InstalledIntegrationService({ registry: {} });
    await service._updateConfig(config => {
      config.installed = [];
      return 'done';
    });
    expect(applyConfigReloadHooks).toHaveBeenCalledWith({ entries: [INTEGRATIONS_FILE] });
    expect(order).toEqual(['write', 'refresh', 'apply']);
  });

  it('does not re-apply when nothing was written', async () => {
    updateJson.mockImplementationOnce(async () => ({ written: false }));
    const service = new InstalledIntegrationService({ registry: {} });
    await service._updateConfig(() => undefined);
    expect(applyConfigReloadHooks).not.toHaveBeenCalled();
  });
});
