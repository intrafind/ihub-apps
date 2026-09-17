#!/usr/bin/env node

/**
 * Migration V106 specs — seeding the artifact store's settings.
 *
 * The seeded values are the built-in defaults, so the upgrade changes nothing
 * on its own. What matters is that the block lands beside `chats` rather than
 * inside it — artifacts are produced by workflows and agents too, and a
 * setting buried under chats would be the wrong place for all of them to read
 * — that an operator who already decided one of these keeps their value, and
 * that a zero survives rather than being read as "unset" and overwritten,
 * because zero is how a cap is removed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V106__add_artifact_storage.js';
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
  assert.equal(version, '106');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('a plain install gets the artifact defaults, beside chats rather than inside it', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      chats: { enabled: true, retentionDays: 90, maxChatsPerUser: 200, maxMessagesPerChat: 2000 }
    }
  });

  await up(ctx);

  const platform = ctx.files['config/platform.json'];
  assert.deepEqual(platform.artifacts, {
    enabled: true,
    maxBytes: 10485760,
    maxPerBatch: 8
  });
  // A workflow or an agent reading its artifact limits must not have to reach
  // into the chat settings to find them.
  assert.equal(platform.chats.storeArtifacts, undefined);
  assert.equal(platform.chats.retentionDays, 90, 'the settings V097 seeded are untouched');
  assert.equal(platform.chats.maxMessagesPerChat, 2000);
});

test('an install with no chats block at all still gets the artifact block', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/platform.json'].artifacts, {
    enabled: true,
    maxBytes: 10485760,
    maxPerBatch: 8
  });
  assert.equal(ctx.files['config/platform.json'].chats, undefined, 'V097 owns the chats block');
});

test('an operator who already decided keeps their values, zero included', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      artifacts: { enabled: false, maxBytes: 0, maxPerBatch: 2 }
    }
  });

  await up(ctx);

  const { artifacts } = ctx.files['config/platform.json'];
  assert.equal(artifacts.enabled, false, 'a deliberate opt-out is not undone');
  assert.equal(artifacts.maxBytes, 0, 'zero removes the cap and must survive');
  assert.equal(artifacts.maxPerBatch, 2);
});
