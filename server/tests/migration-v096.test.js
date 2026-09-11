#!/usr/bin/env node

/**
 * Migration V096 specs — seeding the `storage` section in platform.json.
 *
 * Only the filesystem provider exists, and it is the default, so the migration
 * seeds nothing but the built-in defaults: an upgrade changes no behaviour and
 * only makes the section visible in Admin → Platform Configuration. An admin
 * who already picked a provider (possibly one a later release registers) keeps
 * that choice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V096__add_storage_settings.js';
import { setDefault } from '../migrations/utils.js';

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '096');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('a plain install gets the filesystem provider and its defaults', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/platform.json'].storage, {
    provider: 'filesystem',
    filesystem: { dataDir: 'data', flushIntervalMs: 2000 }
  });
  assert.ok(ctx.logs.some(l => l.includes('storage')));
});

test("an admin's existing choice wins over the default", async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      storage: { provider: 'postgres', postgres: { url: 'postgres://db/ihub' } }
    }
  });

  await up(ctx);
  const { storage } = ctx.files['config/platform.json'];

  // A provider this release does not register is left alone: `provider` is a
  // free string in the schema precisely so such an install stays valid.
  assert.equal(storage.provider, 'postgres');
  assert.deepEqual(storage.postgres, { url: 'postgres://db/ihub' });
  // The filesystem block is still seeded — it is the fallback provider's config.
  assert.deepEqual(storage.filesystem, { dataDir: 'data', flushIntervalMs: 2000 });
});

test('a partially configured filesystem block keeps its tuned values', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      storage: { filesystem: { flushIntervalMs: 500 } }
    }
  });

  await up(ctx);
  const { storage } = ctx.files['config/platform.json'];

  assert.equal(storage.provider, 'filesystem');
  assert.deepEqual(storage.filesystem, { flushIntervalMs: 500, dataDir: 'data' });
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { storage: {} } });
  await up(ctx);
  const once = JSON.stringify(ctx.files['config/platform.json']);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['config/platform.json']), once);
});

test('unrelated platform sections survive untouched', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      defaultLanguage: 'de',
      auth: { mode: 'oidc', authenticatedGroup: 'authenticated' },
      runLog: { enabled: true, retentionDays: 90, flushIntervalMs: 2000 },
      features: { runLog: false }
    }
  });

  await up(ctx);
  const platform = ctx.files['config/platform.json'];

  assert.equal(platform.defaultLanguage, 'de');
  assert.deepEqual(platform.auth, { mode: 'oidc', authenticatedGroup: 'authenticated' });
  assert.deepEqual(platform.runLog, { enabled: true, retentionDays: 90, flushIntervalMs: 2000 });
  assert.deepEqual(platform.features, { runLog: false });
});
