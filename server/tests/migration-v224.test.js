// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version
} from '../migrations/V224__remove_examples_marketplace_registry.js';

const EXAMPLES = {
  id: 'ihub-examples',
  name: 'iHub Examples',
  source: 'https://raw.githubusercontent.com/intrafind/ihub-apps/main/examples/catalog.json',
  enabled: true
};
const OFFICIAL = {
  id: 'ihub-official',
  name: 'iHub Official Marketplace',
  source: 'https://raw.githubusercontent.com/intrafind/ihub-marketplace/main/catalog.json'
};

function makeCtx(files) {
  const store = structuredClone(files);
  const deleted = [];
  let writes = 0;
  return {
    store,
    deleted,
    writes: () => writes,
    fileExists: async p => p in store,
    readJson: async p => structuredClone(store[p]),
    writeJson: async (p, data) => {
      writes++;
      store[p] = data;
    },
    deleteFile: async p => {
      deleted.push(p);
      delete store[p];
    },
    log: () => {}
  };
}

describe('migration V224', () => {
  it('has version 224', () => assert.equal(version, '224'));

  it('needs config/registries.json', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/registries.json': {} })), true);
  });

  it('removes the examples registry and its cached catalog, and nothing else', async () => {
    const custom = { id: 'acme', name: 'Acme', source: 'https://example.com/catalog.json' };
    const ctx = makeCtx({
      'config/registries.json': { registries: [OFFICIAL, EXAMPLES, custom] },
      '.registry-cache/ihub-examples.json': { catalog: {} },
      '.registry-cache/ihub-official.json': { catalog: {} },
      'config/installations.json': {
        installations: { 'model:claude-sonnet-5': { registryId: 'ihub-examples' } }
      }
    });
    await up(ctx);
    assert.deepEqual(ctx.store['config/registries.json'].registries, [OFFICIAL, custom]);
    assert.deepEqual(ctx.deleted, ['.registry-cache/ihub-examples.json']);
    assert.ok('.registry-cache/ihub-official.json' in ctx.store);
    // installed copies stay and keep their record
    assert.equal(
      ctx.store['config/installations.json'].installations['model:claude-sonnet-5'].registryId,
      'ihub-examples'
    );
  });

  it('works without a cached catalog', async () => {
    const ctx = makeCtx({ 'config/registries.json': { registries: [EXAMPLES] } });
    await up(ctx);
    assert.deepEqual(ctx.store['config/registries.json'].registries, []);
    assert.deepEqual(ctx.deleted, []);
  });

  it('leaves a registry with that id but another source (an admin edit) alone', async () => {
    const edited = { ...EXAMPLES, source: 'https://intranet.example.com/examples/catalog.json' };
    const ctx = makeCtx({
      'config/registries.json': { registries: [OFFICIAL, edited] },
      '.registry-cache/ihub-examples.json': { catalog: {} }
    });
    await up(ctx);
    assert.equal(ctx.writes(), 0);
    assert.deepEqual(ctx.deleted, []);
  });

  it('does nothing when the registry is not there or the file has no list', async () => {
    for (const config of [{ registries: [OFFICIAL] }, { registries: [] }, {}]) {
      const ctx = makeCtx({ 'config/registries.json': config });
      await up(ctx);
      assert.equal(ctx.writes(), 0);
    }
  });
});
