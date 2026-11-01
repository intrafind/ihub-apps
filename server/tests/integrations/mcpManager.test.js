// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `initializeMcpFromInstallations` is called from several places (startup,
 * the integrations.json reload hook, the MCP adapter's `onChanged` on a
 * definition change). The manager's `initialize` must not run twice at once,
 * so concurrent calls are serialized: one run, then one more for whoever
 * arrived during it.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const manager = {
  initialize: jest.fn(),
  connectAll: jest.fn(async () => {})
};
jest.unstable_mockModule('../../services/mcp/McpClientManager.js', () => ({ default: manager }));
jest.unstable_mockModule('../../services/integrations/InstalledIntegrationService.js', () => ({
  default: {
    list: () => [],
    resolve: async () => null,
    security: () => ({ blockPrivateIps: true, allowedHosts: [] })
  }
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { initializeMcpFromInstallations } =
  await import('../../services/integrations/protocols/mcp/manager.js');

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  manager.initialize.mockReset();
  manager.connectAll.mockClear();
});

describe('initializeMcpFromInstallations', () => {
  it('serializes concurrent runs: one in flight, one queued for the latecomers', async () => {
    const first = deferred();
    manager.initialize.mockImplementationOnce(() => first.promise);
    manager.initialize.mockImplementation(async () => {});

    const a = initializeMcpFromInstallations();
    const b = initializeMcpFromInstallations();
    const c = initializeMcpFromInstallations({ connect: true });
    await Promise.resolve();
    expect(manager.initialize).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.all([a, b, c]);
    // b and c shared one follow-up run after a's, which carried c's eager connect.
    expect(manager.initialize).toHaveBeenCalledTimes(2);
    expect(manager.connectAll).toHaveBeenCalledTimes(1);
  });

  it('runs again once the previous run is over', async () => {
    manager.initialize.mockImplementation(async () => {});
    await initializeMcpFromInstallations();
    await initializeMcpFromInstallations();
    expect(manager.initialize).toHaveBeenCalledTimes(2);
    expect(manager.connectAll).not.toHaveBeenCalled();
  });

  it('never throws when the manager fails', async () => {
    manager.initialize.mockRejectedValue(new Error('boom'));
    await expect(initializeMcpFromInstallations()).resolves.toBeUndefined();
  });
});
