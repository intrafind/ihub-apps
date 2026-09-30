#!/usr/bin/env node

/**
 * Migration V138 specs — seeds the platform-wide voice-input defaults
 * (speech.defaultService, speech.transcription.defaultModelId) with values
 * that keep today's behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setDefault } from '../migrations/utils.js';
import { up, precondition, version } from '../migrations/V138__add_speech_platform_defaults.js';

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, data) => {
      files[p] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version matches the file name', () => {
  assert.equal(version, '138');
});

test('precondition requires platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('seeds the browser as default service and no default transcription model', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { speech: { realtime: { enabled: true, url: 'ws://x' } } }
  });
  await up(ctx);

  const speech = ctx.files['config/platform.json'].speech;
  assert.equal(speech.defaultService, 'browser');
  assert.deepEqual(speech.transcription, { defaultModelId: '' });
  // Existing backend settings are untouched.
  assert.deepEqual(speech.realtime, { enabled: true, url: 'ws://x' });
});

test('keeps values an admin already set', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      speech: { defaultService: 'vllm-realtime', transcription: { defaultModelId: 'voxtral' } }
    }
  });
  await up(ctx);

  const speech = ctx.files['config/platform.json'].speech;
  assert.equal(speech.defaultService, 'vllm-realtime');
  assert.equal(speech.transcription.defaultModelId, 'voxtral');
});

test('creates the speech block on a platform.json without one', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { defaultLanguage: 'de' } });
  await up(ctx);

  assert.deepEqual(ctx.files['config/platform.json'], {
    defaultLanguage: 'de',
    speech: { defaultService: 'browser', transcription: { defaultModelId: '' } }
  });
});
