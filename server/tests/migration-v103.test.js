#!/usr/bin/env node

/**
 * Migration V103 specs — seeding the durable-chat artifact settings.
 *
 * The seeded values are the built-in defaults, so the upgrade changes nothing
 * on its own: an installation with durable chats off stores no chats and
 * therefore no artifacts either. What matters is that an operator who already
 * decided one of these — switched artifact storage off, or lowered the size
 * cap — keeps their value, and that a zero is preserved rather than read as
 * "unset" and overwritten with the default, because zero is how a cap is
 * removed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V103__add_chat_artifact_storage.js';
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
  assert.equal(version, '103');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('an install that already has the chats block gains the artifact settings', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      chats: { enabled: true, retentionDays: 90, maxChatsPerUser: 200, maxMessagesPerChat: 2000 }
    }
  });

  await up(ctx);

  const { chats } = ctx.files['config/platform.json'];
  assert.equal(chats.storeArtifacts, true);
  assert.equal(chats.maxArtifactBytes, 10485760);
  assert.equal(chats.maxArtifactsPerMessage, 8);
  assert.equal(chats.retentionDays, 90, 'the settings V097 seeded are untouched');
  assert.equal(chats.maxMessagesPerChat, 2000);
});

test('an install without a chats block gets one carrying only these keys', async () => {
  // V097 owns `enabled`, `retentionDays` and the two caps; re-seeding them
  // here would mean two migrations claiming the same defaults.
  const ctx = fakeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/platform.json'].chats, {
    storeArtifacts: true,
    maxArtifactBytes: 10485760,
    maxArtifactsPerMessage: 8
  });
});

test('an operator who already decided keeps their values, zero included', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      chats: { storeArtifacts: false, maxArtifactBytes: 0, maxArtifactsPerMessage: 2 }
    }
  });

  await up(ctx);

  const { chats } = ctx.files['config/platform.json'];
  assert.equal(chats.storeArtifacts, false, 'a deliberate opt-out is not undone');
  assert.equal(chats.maxArtifactBytes, 0, 'zero removes the cap and must survive');
  assert.equal(chats.maxArtifactsPerMessage, 2);
});
