// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A failed read of the shared client registration is not "no registration":
 * answering null would make the connect flow register a new DCR client and
 * overwrite the record every user's refresh token is bound to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpOAuthClientStore } from '../services/mcp/mcpOAuthClientStore.js';

const failing = () => ({
  async get() {
    throw new Error('document store unavailable');
  },
  async put() {
    throw new Error('put must not be reached after a failed read');
  }
});

describe('McpOAuthClientStore: a failed read', () => {
  it('propagates from get and getFor instead of reporting no registration', async () => {
    const store = new McpOAuthClientStore({ documents: failing() });
    await assert.rejects(() => store.get('okta'), /document store unavailable/);
    await assert.rejects(() => store.getFor({ id: 'okta' }), /document store unavailable/);
  });

  it('never overwrites the shared record: put and update fail with the read', async () => {
    const store = new McpOAuthClientStore({ documents: failing() });
    await assert.rejects(
      () => store.put('okta', { clientId: 'new' }),
      /document store unavailable/
    );
    await assert.rejects(
      () => store.update('okta', { clientId: 'x' }),
      /document store unavailable/
    );
  });

  it('still answers null for a server that has no registration', async () => {
    const store = new McpOAuthClientStore({ documents: { get: async () => null } });
    assert.equal(await store.get('okta'), null);
    assert.equal(await store.get(''), null);
  });
});
