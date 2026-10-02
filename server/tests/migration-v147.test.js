#!/usr/bin/env node

/**
 * Migration V147 specs — seeds the disabled Gemini TTS models next to Voxtral
 * TTS, without touching a model file an admin already has.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { up, precondition, version } from '../migrations/V147__seed_google_tts_models.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';

const PATHS = ['models/gemini-3.8-flash-tts.json', 'models/gemini-3.8-flash-lite-tts.json'];
const shipped = path =>
  JSON.parse(fs.readFileSync(new URL(`../defaults/${path}`, import.meta.url), 'utf8'));
const allDefaults = () => Object.fromEntries(PATHS.map(path => [path, shipped(path)]));

function fakeCtx(files, defaults = allDefaults()) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async p => {
      if (!(p in defaults)) throw new Error(`missing default ${p}`);
      return JSON.parse(JSON.stringify(defaults[p]));
    },
    writeJson: async (p, data) => {
      files[p] = data;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version matches the file name', () => {
  assert.equal(version, '147');
});

test('precondition requires platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('the shipped defaults are valid, disabled Google TTS models', () => {
  for (const path of PATHS) {
    const model = shipped(path);
    assert.equal(modelConfigSchema.safeParse(model).success, true, path);
    assert.equal(model.provider, 'google');
    assert.equal(model.modelType, 'tts');
    assert.equal(model.enabled, false);
  }
});

test('seeds both model files, disabled', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} });
  await up(ctx);
  for (const path of PATHS) {
    assert.deepEqual(ctx.files[path], { ...shipped(path), enabled: false, default: false });
  }
});

test('keeps a model file an admin already has', async () => {
  const mine = { ...shipped(PATHS[0]), enabled: true, tts: { voice: 'Puck' } };
  const ctx = fakeCtx({ 'config/platform.json': {}, [PATHS[0]]: mine });
  await up(ctx);
  assert.deepEqual(ctx.files[PATHS[0]], mine);
  assert.deepEqual(ctx.writes, [PATHS[1]]);
});

test('warns and writes nothing when the defaults are missing', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} }, {});
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.logs.filter(line => line.includes('not found')).length, 2);
});
