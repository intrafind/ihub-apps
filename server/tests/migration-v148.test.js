#!/usr/bin/env node

/**
 * Migration V148 specs — seeds the disabled Mistral realtime transcription
 * model (voxtral-mini-transcribe-realtime-2602) next to the vLLM one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  up,
  precondition,
  version
} from '../migrations/V148__seed_mistral_realtime_transcription_model.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';

const MODEL_PATH = 'models/voxtral-mini-transcribe-realtime.json';
const shippedDefault = () =>
  JSON.parse(fs.readFileSync(new URL(`../defaults/${MODEL_PATH}`, import.meta.url), 'utf8'));

function fakeCtx(files, defaults = { [MODEL_PATH]: shippedDefault() }) {
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
  assert.equal(version, '148');
});

test('precondition requires platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('the shipped default is a valid, disabled Mistral transcription model', () => {
  const model = shippedDefault();
  assert.equal(modelConfigSchema.safeParse(model).success, true);
  assert.equal(model.provider, 'mistral');
  assert.equal(model.modelType, 'transcription');
  assert.equal(model.modelId, 'voxtral-mini-transcribe-realtime-2602');
  assert.equal(model.enabled, false);
});

test('seeds the model file, disabled', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} });
  await up(ctx);
  assert.deepEqual(ctx.files[MODEL_PATH], { ...shippedDefault(), enabled: false, default: false });
});

test('keeps a model file an admin already has', async () => {
  const mine = { ...shippedDefault(), enabled: true, apiKey: 'ENC[x]' };
  const ctx = fakeCtx({ 'config/platform.json': {}, [MODEL_PATH]: mine });
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
  assert.deepEqual(ctx.files[MODEL_PATH], mine);
});

test('warns and writes nothing when the default is missing', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} }, {});
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
  assert.ok(ctx.logs.some(line => line.includes('not found')));
});
