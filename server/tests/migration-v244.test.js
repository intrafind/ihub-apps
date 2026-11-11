// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V244 specs — provenance.media defaults on the platform.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { precondition, up, version } from '../migrations/V244__provenance_media_defaults.js';

function context(files) {
  const written = {};
  const store = structuredClone(files);
  return {
    written,
    fileExists: async file => file in store,
    readJson: async file => structuredClone(store[file]),
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

test('version', () => assert.equal(version, '244'));

test('runs only when there is a platform.json', async () => {
  assert.equal(await precondition(context({ 'config/platform.json': {} })), true);
  assert.equal(await precondition(context({})), false);
});

test('writes the media block and keeps what an admin set', async () => {
  const ctx = context({
    'config/platform.json': {
      provenance: { retentionDays: 30, media: { readC2pa: false } }
    }
  });
  await up(ctx);
  assert.deepEqual(ctx.written['config/platform.json'].provenance, {
    retentionDays: 30,
    media: { readC2pa: false, maxVerifyBytes: 52428800 }
  });
});

test('is idempotent', async () => {
  const first = context({ 'config/platform.json': {} });
  await up(first);
  const second = context({ 'config/platform.json': first.written['config/platform.json'] });
  await up(second);
  assert.deepEqual(second.written['config/platform.json'], first.written['config/platform.json']);
});

test('the shipped platform defaults carry the same media block', async () => {
  const { readFileSync } = await import('node:fs');
  const defaults = JSON.parse(
    readFileSync(new URL('../defaults/config/platform.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(defaults.provenance.media, {
    maxVerifyBytes: 52428800,
    readC2pa: true
  });
});
