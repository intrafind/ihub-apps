#!/usr/bin/env node

/**
 * Migration V097 specs — seeding the `chats` section in platform.json and
 * carrying the chat-history preview flag over to durable chats.
 *
 * The seeded values are the built-in defaults, so the upgrade itself changes
 * no behaviour: durable chats stay dark behind `features.chatPersistence`.
 * The interesting half is the carry-over — an admin who had turned on the
 * sample-data chat history asked for chat history, and must not lose the UI
 * when the flag behind it changes — while any explicit `chatPersistence`
 * choice still wins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V097__add_chat_persistence.js';
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
  assert.equal(version, '097');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('a plain install gets the chats defaults', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/platform.json'].chats, {
    enabled: true,
    retentionDays: 90,
    maxChatsPerUser: 200,
    maxMessagesPerChat: 2000
  });
  assert.ok(ctx.logs.some(l => l.includes('chats')));
});

test("an admin's existing chats settings win over the defaults", async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      chats: { enabled: false, retentionDays: 0 }
    }
  });

  await up(ctx);
  const { chats } = ctx.files['config/platform.json'];

  // retentionDays 0 means "keep forever" — a meaningful value, not a missing
  // one, so the default must not overwrite it.
  assert.equal(chats.enabled, false);
  assert.equal(chats.retentionDays, 0);
  assert.equal(chats.maxChatsPerUser, 200);
});

test('an enabled chat history preview is carried over to chatPersistence', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'config/features.json': { chatHistoryPreview: true, runLog: true }
  });

  await up(ctx);
  const features = ctx.files['config/features.json'];

  assert.equal(features.chatPersistence, true);
  // The old key is left alone. It no longer gates anything — this release
  // removed its last reader — but removing a value an admin set is not the
  // migration's business, and residue cannot turn a feature on.
  assert.equal(features.chatHistoryPreview, true);
  assert.equal(features.runLog, true);
});

test('a disabled or absent preview flag carries nothing over', async () => {
  const off = fakeCtx({
    'config/platform.json': {},
    'config/features.json': { chatHistoryPreview: false }
  });
  await up(off);
  assert.equal('chatPersistence' in off.files['config/features.json'], false);

  const absent = fakeCtx({
    'config/platform.json': {},
    'config/features.json': { export: true }
  });
  await up(absent);
  assert.equal('chatPersistence' in absent.files['config/features.json'], false);
});

test('an explicit chatPersistence choice survives the carry-over', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'config/features.json': { chatHistoryPreview: true, chatPersistence: false }
  });

  await up(ctx);

  assert.equal(ctx.files['config/features.json'].chatPersistence, false);
});

test('an install without features.json is untouched', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} });

  await up(ctx);

  assert.equal('config/features.json' in ctx.files, false);
  assert.ok(ctx.logs.some(l => l.includes('features.json')));
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { chats: {} },
    'config/features.json': { chatHistoryPreview: true }
  });
  await up(ctx);
  const once = JSON.stringify(ctx.files);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files), once);
});

test('unrelated platform sections survive untouched', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      defaultLanguage: 'de',
      auth: { mode: 'oidc', authenticatedGroup: 'authenticated' },
      runLog: { enabled: true, retentionDays: 90, identityMode: 'pseudonymized' },
      storage: { provider: 'filesystem', filesystem: { dataDir: 'data' } }
    }
  });

  await up(ctx);
  const platform = ctx.files['config/platform.json'];

  assert.equal(platform.defaultLanguage, 'de');
  assert.deepEqual(platform.auth, { mode: 'oidc', authenticatedGroup: 'authenticated' });
  assert.deepEqual(platform.runLog, {
    enabled: true,
    retentionDays: 90,
    identityMode: 'pseudonymized'
  });
  assert.deepEqual(platform.storage, { provider: 'filesystem', filesystem: { dataDir: 'data' } });
});
