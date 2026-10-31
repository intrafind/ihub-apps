// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP protocol adapter follows definition changes: `onChanged` rebuilds
 * the MCP client manager from the installations (a re-installed definition
 * may fix another endpoint, headers or MCP Apps setting), and the protocol
 * index tells it on a registry reload.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const initializeMcpFromInstallations = jest.fn(async () => {});
jest.unstable_mockModule('../../services/integrations/protocols/mcp/manager.js', () => ({
  initializeMcpFromInstallations,
  mcpManagerConfig: jest.fn()
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const adapter = await import('../../services/integrations/protocols/mcp/McpAdapter.js');
const { notifyDefinitionsChanged, getProtocolAdapter } =
  await import('../../services/integrations/protocols/index.js');

beforeEach(() => {
  initializeMcpFromInstallations.mockClear();
});

describe('McpAdapter.onChanged', () => {
  it('rebuilds the MCP client manager from the installations, without an eager connect', async () => {
    await adapter.onChanged({ definitionIds: ['mcp/github'] });
    expect(initializeMcpFromInstallations).toHaveBeenCalledTimes(1);
    // Same semantics as the reload hook for integrations.json: the next use
    // connects; the eager connectAll of the singleton worker is a startup matter.
    const [options] = initializeMcpFromInstallations.mock.calls[0];
    expect(options?.connect ?? false).toBe(false);
  });

  it('is told by the protocol index when definitions were reloaded', async () => {
    expect(getProtocolAdapter('mcp').onChanged).toBe(adapter.onChanged);
    await notifyDefinitionsChanged({ definitionIds: ['mcp/github'] });
    expect(initializeMcpFromInstallations).toHaveBeenCalledTimes(1);
    await notifyDefinitionsChanged();
    expect(initializeMcpFromInstallations).toHaveBeenCalledTimes(2);
  });

  it('does not let a failing adapter stop the dispatch', async () => {
    initializeMcpFromInstallations.mockRejectedValueOnce(new Error('manager down'));
    await expect(notifyDefinitionsChanged()).resolves.toBeUndefined();
  });
});
