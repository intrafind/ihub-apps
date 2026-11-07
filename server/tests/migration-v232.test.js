// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V232 specs — the chat titles setting gets its (off) default and
 * nothing the admin already set is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { precondition, up, version } from '../migrations/V232__chat_titles_setting.js';

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

test('version', () => assert.equal(version, '232'));

test('only runs when there is a platform.json', async () => {
  assert.equal(await precondition(context({})), true);
  assert.equal(await precondition(context(null)), false);
});

test('writes the off default next to the other chat settings', async () => {
  const ctx = context({ chats: { enabled: true, retentionDays: 30 } });
  await up(ctx);
  assert.deepEqual(ctx.written['config/platform.json'].chats, {
    enabled: true,
    retentionDays: 30,
    titles: { enabled: false, modelId: '' }
  });
});

test('keeps what an admin already set', async () => {
  const ctx = context({ chats: { titles: { enabled: true, modelId: 'small' } } });
  await up(ctx);
  assert.deepEqual(ctx.written['config/platform.json'].chats.titles, {
    enabled: true,
    modelId: 'small'
  });
});
