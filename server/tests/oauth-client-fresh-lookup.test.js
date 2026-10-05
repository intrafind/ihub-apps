/**
 * OAuth client lookups across cluster workers.
 *
 * Each worker caches oauth-clients.json and learns about another worker's
 * write over the config sync bus a few milliseconds later. A client created on
 * one worker (DCR, the admin UI) is routinely used on another inside that
 * window — an MCP client registers and immediately sends the user to
 * /authorize — and the lookup used to fail with `invalid_client`.
 *
 * Locked in here, with this worker's cached copy and the store on disk
 * deliberately out of step:
 * - a client present on disk but not in the cache authenticates and resolves,
 * - a secret rotated on another worker is honoured, the old one refused,
 * - an unknown client or wrong secret costs one re-read, not a retry loop,
 * - a write starts from the file on disk, so it cannot drop a client another
 *   worker just added,
 * - concurrent re-reads share one store read.
 *
 * Native-ESM jest; see the `test:oauth` npm script.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const CLIENTS_KEY = 'config/oauth-clients.json';

const state = {
  cache: null, // this worker's copy
  disk: null, // the shared file
  reads: 0
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    get: key => (key === CLIENTS_KEY && state.cache ? { data: state.cache } : null),
    setCacheEntry: (key, data) => {
      if (key === CLIENTS_KEY) state.cache = structuredClone(data);
    }
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => {
      state.reads += 1;
      // Let concurrent callers pile up behind one read.
      await new Promise(resolve => setTimeout(resolve, 5));
      return state.disk ? structuredClone(state.disk) : null;
    },
    writeJson: async (_relPath, data) => {
      state.disk = structuredClone(data);
    }
  }
}));

jest.unstable_mockModule('../configSync.js', () => ({
  announceConfigChange: () => {}
}));

const { validateClientCredentials, hashClientSecret, findClientByIdFresh, updateOAuthClient } =
  await import('../utils/oauthClientManager.js');
const { resolveOAuthClient } = await import('../utils/oauthClientResolver.js');

const CLIENTS_FILE = 'contents/config/oauth-clients.json';

function record(clientId, clientSecret, extra = {}) {
  return {
    clientId,
    name: clientId,
    clientSecret,
    active: true,
    scopes: [],
    grantTypes: ['client_credentials'],
    ...extra
  };
}

function file(clients) {
  return { clients, metadata: { version: '1.0.0' } };
}

describe('OAuth client lookups when this worker’s cache is behind', () => {
  let secretHash;

  beforeEach(async () => {
    secretHash ??= await hashClientSecret('right-secret');
    state.reads = 0;
  });

  it('authenticates a client that only exists on disk so far', async () => {
    state.cache = file({});
    state.disk = file({ fresh_client: record('fresh_client', secretHash) });

    const client = await validateClientCredentials('fresh_client', 'right-secret', CLIENTS_FILE);

    expect(client?.clientId).toBe('fresh_client');
    expect(client.clientSecret).toBeUndefined();
    // The cache now holds what the store holds.
    expect(state.cache.clients.fresh_client).toBeDefined();
  });

  it('honours a secret rotated on another worker and refuses the old one', async () => {
    const oldHash = await hashClientSecret('old-secret');
    state.cache = file({ rotated: record('rotated', oldHash) });
    state.disk = file({ rotated: record('rotated', secretHash) });

    expect(await validateClientCredentials('rotated', 'right-secret', CLIENTS_FILE)).not.toBeNull();
    expect(await validateClientCredentials('rotated', 'old-secret', CLIENTS_FILE)).toBeNull();
  });

  it('refuses an unknown client after a single re-read', async () => {
    state.cache = file({});
    state.disk = file({});

    expect(await validateClientCredentials('nobody', 'x', CLIENTS_FILE)).toBeNull();
    expect(state.reads).toBe(1);
  });

  it('refuses a wrong secret for an unchanged record', async () => {
    state.cache = file({ steady: record('steady', secretHash) });
    state.disk = file({ steady: record('steady', secretHash) });

    expect(await validateClientCredentials('steady', 'wrong', CLIENTS_FILE)).toBeNull();
    expect(state.reads).toBe(1);
  });

  it('does not re-read the store for a client the cache already has', async () => {
    // Recently used, so the lastUsed touch has nothing to write either.
    const lastUsed = new Date().toISOString();
    state.cache = file({ steady: record('steady', secretHash, { lastUsed }) });
    state.disk = file({ steady: record('steady', secretHash, { lastUsed }) });

    expect(await validateClientCredentials('steady', 'right-secret', CLIENTS_FILE)).not.toBeNull();
    expect(state.reads).toBe(0);
  });

  it('resolves a stored client that only exists on disk so far', async () => {
    state.cache = file({});
    state.disk = file({ dcr_client: record('dcr_client', null, { clientType: 'public' }) });

    const resolved = await resolveOAuthClient('dcr_client', {});

    expect(resolved.ok).toBe(true);
    expect(resolved.client.clientId).toBe('dcr_client');
  });

  it('still answers unknown client_id for a client that exists nowhere', async () => {
    state.cache = file({});
    state.disk = file({});

    const resolved = await resolveOAuthClient('ghost', {});

    expect(resolved).toMatchObject({ ok: false, error: 'invalid_client' });
  });

  it('writes on top of the file on disk, keeping a client another worker added', async () => {
    state.cache = file({ mine: record('mine', secretHash) });
    state.disk = file({
      mine: record('mine', secretHash),
      theirs: record('theirs', secretHash)
    });

    await updateOAuthClient('mine', { description: 'edited' }, CLIENTS_FILE, 'admin');

    expect(state.disk.clients.mine.description).toBe('edited');
    expect(state.disk.clients.theirs).toBeDefined();
  });

  it('shares one store read between concurrent lookups', async () => {
    state.cache = file({});
    state.disk = file({ a: record('a', secretHash), b: record('b', secretHash) });

    const [a, b] = await Promise.all([
      findClientByIdFresh(CLIENTS_FILE, 'a'),
      findClientByIdFresh(CLIENTS_FILE, 'b')
    ]);

    expect(a.client?.clientId).toBe('a');
    expect(b.client?.clientId).toBe('b');
    expect(state.reads).toBe(1);
  });
});
