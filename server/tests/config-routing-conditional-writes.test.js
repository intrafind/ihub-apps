/**
 * A provider may only serve raw configuration if it can do compare-and-set.
 *
 * `ConfigStore.createJson()` promises create-or-fail, and the admin POST
 * handlers for apps, agents and prompts map its `EEXIST` onto HTTP 409. On the
 * document path that promise is nothing but the `etag: null` conditional
 * write — and `conditionalWrites` is explicitly optional in the capability
 * contract, with the conformance suite skipping the whole CAS group for a
 * provider that declares it false.
 *
 * So a step-2 provider could serve `contents/apps` with CAS off, pass
 * conformance, and answer 200 to the second admin creating the same app id,
 * having silently replaced the first. The store declines to route raw
 * configuration to such a provider: the filesystem path it falls back to still
 * has `atomicCreateJSON`'s O_EXCL, so the guarantee survives and only the
 * routing is lost.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: null, provider: null };

/**
 * A provider that records every document call, so a test can tell whether the
 * store routed to it or went to the filesystem.
 *
 * @param {boolean} conditionalWrites - What the provider claims it can do
 * @returns {Object} The fake provider
 */
function fakeProvider(conditionalWrites) {
  const calls = [];
  return {
    name: `fake-${conditionalWrites ? 'cas' : 'nocas'}`,
    calls,
    getCapabilities: () => ({
      rawNamespaces: ['config', 'apps'],
      conditionalWrites
    }),
    documents: {
      async put(ns, key, data, opts) {
        calls.push({ op: 'put', ns, key, opts });
        return { ns, key, data, etag: 'fake' };
      },
      async get(ns, key) {
        calls.push({ op: 'get', ns, key });
        return null;
      }
    }
  };
}

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => state.provider
}));

const { default: configStore } = await import('../services/config/ConfigStore.js');

const onDisk = relPath => path.join(state.rootDir, 'contents', relPath);

describe('ConfigStore raw-namespace routing', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-cfg-cas-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.mkdir(path.join(state.rootDir, 'contents', 'apps'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
    state.provider = null;
  });

  test('routes to a provider that declares conditional writes', async () => {
    state.provider = fakeProvider(true);

    await configStore.writeJson('config/platform.json', { ok: true });

    expect(state.provider.calls.map(call => call.op)).toContain('put');
    // Nothing reached the filesystem: the provider owns the namespace.
    await expect(fs.access(onDisk('config/platform.json'))).rejects.toThrow();
  });

  test('declines a provider that declares raw namespaces without conditional writes', async () => {
    state.provider = fakeProvider(false);

    await configStore.writeJson('config/platform.json', { ok: true });

    // The failure this prevents is silent: the provider would accept the write
    // and later accept a second create of an existing id just as happily.
    expect(state.provider.calls).toEqual([]);
    expect(JSON.parse(await fs.readFile(onDisk('config/platform.json'), 'utf8'))).toEqual({
      ok: true
    });
  });

  test('create-or-fail still fails on the second create when the provider is declined', async () => {
    state.provider = fakeProvider(false);

    await configStore.createJson('apps/dup.json', { id: 'dup' });
    // The guarantee the routing decision exists to protect, on the path it
    // falls back to: O_EXCL, not a read followed by a write.
    await expect(configStore.createJson('apps/dup.json', { id: 'other' })).rejects.toMatchObject({
      code: 'EEXIST'
    });
    expect(JSON.parse(await fs.readFile(onDisk('apps/dup.json'), 'utf8'))).toEqual({ id: 'dup' });
  });
});
