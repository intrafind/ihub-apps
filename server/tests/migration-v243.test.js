// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V243 specs — provenance defaults on the platform and on chat models.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { precondition, up, version } from '../migrations/V243__provenance_defaults.js';

function context(files) {
  const written = {};
  const store = structuredClone(files);
  return {
    written,
    fileExists: async file => file in store,
    listFiles: async directory =>
      Object.keys(store)
        .filter(f => f.startsWith(`${directory}/`))
        .map(f => f.slice(directory.length + 1)),
    readJson: async file => {
      if (store[file] === 'corrupt') throw new Error('bad json');
      return structuredClone(store[file]);
    },
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

test('version', () => assert.equal(version, '243'));

test('runs when there is a platform.json or a model', async () => {
  assert.equal(await precondition(context({ 'config/platform.json': {} })), true);
  assert.equal(await precondition(context({ 'models/a.json': {} })), true);
  assert.equal(await precondition(context({})), false);
});

test('writes the provenance block and keeps what an admin set', async () => {
  const ctx = context({ 'config/platform.json': { provenance: { retentionDays: 30 } } });
  await up(ctx);
  assert.deepEqual(ctx.written['config/platform.json'].provenance, {
    retentionDays: 30,
    storeRecords: true,
    verify: { access: 'authenticated' }
  });
});

test('marks chat models as not marked, never infers a provider mark', async () => {
  const ctx = context({
    'models/chat.json': { id: 'chat', provider: 'google' },
    'models/typed.json': { id: 'typed', modelType: 'chat' },
    'models/stt.json': { id: 'stt', modelType: 'transcription' },
    'models/tts.json': { id: 'tts', modelType: 'tts' },
    'models/set.json': {
      id: 'set',
      contentMarking: { text: { by: 'provider', scheme: 'synthid' } }
    },
    'models/bad.json': 'corrupt'
  });
  await up(ctx);
  assert.deepEqual(ctx.written['models/chat.json'].contentMarking, { text: { by: 'none' } });
  assert.deepEqual(ctx.written['models/typed.json'].contentMarking, { text: { by: 'none' } });
  assert.equal(ctx.written['models/stt.json'], undefined);
  assert.equal(ctx.written['models/tts.json'], undefined);
  assert.equal(ctx.written['models/set.json'], undefined, 'an admin-set marking is not rewritten');
  assert.equal(ctx.written['models/bad.json'], undefined);
});
