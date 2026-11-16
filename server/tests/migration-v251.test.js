// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V251 specs — the chat evidence record settings get their (on)
 * defaults and nothing the admin already set is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { precondition, up, version } from '../migrations/V251__chat_evidence_settings.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';

function context(platform) {
  const written = {};
  return {
    written,
    fileExists: async file => file === 'config/platform.json' && platform !== null,
    readJson: async () => structuredClone(platform),
    writeJson: async (file, data) => {
      written[file] = data;
    },
    setDefault(target, dotted, value) {
      const keys = dotted.split('.');
      let node = target;
      for (const key of keys.slice(0, -1)) node = node[key] ??= {};
      node[keys.at(-1)] ??= value;
    },
    log() {}
  };
}

test('version', () => assert.equal(version, '251'));

test('only runs when there is a platform.json', async () => {
  assert.equal(await precondition(context({})), true);
  assert.equal(await precondition(context(null)), false);
});

test('writes the on default next to the other chat settings', async () => {
  const ctx = context({ chats: { enabled: true, retentionDays: 30 } });
  await up(ctx);
  assert.deepEqual(ctx.written['config/platform.json'].chats, {
    enabled: true,
    retentionDays: 30,
    evidence: { enabled: true, maxContentBytes: 10485760 }
  });
});

test('keeps what an admin already set', async () => {
  const ctx = context({ chats: { evidence: { enabled: false, maxContentBytes: 1024 } } });
  await up(ctx);
  assert.deepEqual(ctx.written['config/platform.json'].chats.evidence, {
    enabled: false,
    maxContentBytes: 1024
  });
});

test('the schema fills in the same defaults', () => {
  const parsed = platformConfigSchema.parse({});
  assert.deepEqual(parsed.chats.evidence, { enabled: true, maxContentBytes: 10485760 });
});
