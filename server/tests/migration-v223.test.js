// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version } from '../migrations/V223__remove_mcp_gateway_sse_transport.js';

function makeCtx(platform) {
  let stored = structuredClone(platform);
  let writes = 0;
  return {
    writes: () => writes,
    stored: () => stored,
    readJson: async () => structuredClone(stored),
    writeJson: async (_path, data) => {
      writes++;
      stored = data;
    },
    log: () => {}
  };
}

describe('migration V223', () => {
  it('has version 223', () => assert.equal(version, '223'));

  it('removes only the sse transport setting', async () => {
    const ctx = makeCtx({
      mcpServer: { transports: { streamableHttp: { enabled: true }, sse: { enabled: true } } }
    });
    await up(ctx);
    assert.deepEqual(ctx.stored().mcpServer.transports, { streamableHttp: { enabled: true } });
  });

  it('does not write when there is nothing to remove', async () => {
    for (const platform of [{}, { mcpServer: {} }, { mcpServer: { transports: {} } }]) {
      const ctx = makeCtx(platform);
      await up(ctx);
      assert.equal(ctx.writes(), 0);
    }
  });
});
