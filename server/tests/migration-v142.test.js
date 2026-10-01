#!/usr/bin/env node

/**
 * Migration V142 specs — read aloud defaults (speech.tts) and the seeded,
 * disabled Voxtral TTS model file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setDefault } from '../migrations/utils.js';
import { up, precondition, version } from '../migrations/V142__add_text_to_speech.js';

const DEFAULT_MODEL = {
  id: 'voxtral-mini-tts',
  modelId: 'voxtral-mini-tts-latest',
  provider: 'mistral',
  modelType: 'tts',
  enabled: false,
  default: false
};

function fakeCtx(files, defaults = { 'models/voxtral-mini-tts.json': DEFAULT_MODEL }) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async p => {
      if (!(p in defaults)) throw new Error(`missing default ${p}`);
      return JSON.parse(JSON.stringify(defaults[p]));
    },
    writeJson: async (p, data) => {
      files[p] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version matches the file name', () => {
  assert.equal(version, '142');
});

test('precondition requires platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('seeds read aloud switched off, with no model', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { speech: { defaultService: 'azure' } }
  });
  await up(ctx);

  const speech = ctx.files['config/platform.json'].speech;
  assert.deepEqual(speech.tts, { enabled: false, defaultModelId: '' });
  assert.equal(speech.defaultService, 'azure');
});

test('keeps read aloud settings an admin already made', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { speech: { tts: { enabled: true, defaultModelId: 'my-tts' } } }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].speech.tts, {
    enabled: true,
    defaultModelId: 'my-tts'
  });
});

test('seeds the Voxtral TTS model disabled', async () => {
  const ctx = fakeCtx(
    { 'config/platform.json': {} },
    { 'models/voxtral-mini-tts.json': { ...DEFAULT_MODEL, enabled: true, default: true } }
  );
  await up(ctx);
  const model = ctx.files['models/voxtral-mini-tts.json'];
  assert.equal(model.modelType, 'tts');
  assert.equal(model.enabled, false);
  assert.equal(model.default, false);
});

test('leaves an existing model file alone', async () => {
  const custom = { ...DEFAULT_MODEL, enabled: true, tts: { voice: 'gb_jane_neutral' } };
  const ctx = fakeCtx({ 'config/platform.json': {}, 'models/voxtral-mini-tts.json': custom });
  await up(ctx);
  assert.deepEqual(ctx.files['models/voxtral-mini-tts.json'], custom);
});

test('tolerates a missing default model file', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} }, {});
  await up(ctx);
  assert.equal('models/voxtral-mini-tts.json' in ctx.files, false);
  assert.deepEqual(ctx.files['config/platform.json'].speech.tts, {
    enabled: false,
    defaultModelId: ''
  });
});
