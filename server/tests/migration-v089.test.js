#!/usr/bin/env node

/**
 * Migration V089 specs — refresh the default model catalog (issue #2282).
 *
 * The load-bearing behaviors: retired models are deleted only when they still
 * match the default we shipped (an admin's own endpoint is never thrown away),
 * apps that referenced a deleted model are repointed, the Gemini 2.5 thinking
 * shape that 400s on Gemini 3 endpoints is rewritten to `thinking.level`, and
 * new models are seeded without ever overwriting an existing file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { up, precondition, version } from '../migrations/V089__refresh_default_models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.join(here, '..', 'defaults');

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  const deletes = [];
  return {
    files,
    logs,
    writes,
    deletes,
    fileExists: async p => Object.prototype.hasOwnProperty.call(files, p),
    listFiles: async dir =>
      Object.keys(files)
        .filter(p => p.startsWith(`${dir}/`))
        .map(p => p.slice(dir.length + 1)),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    // Reads the real shipped defaults, so the seed list can't drift from disk.
    readDefaultJson: async p => JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, p), 'utf8')),
    writeJson: async (p, d) => {
      files[p] = d;
      writes.push(p);
    },
    deleteFile: async p => {
      delete files[p];
      deletes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

/** The retired defaults exactly as they were shipped before this migration. */
const shippedGpt4 = () => ({
  id: 'gpt-4',
  modelId: 'gpt-4',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai',
  enabled: false
});
const shippedGptOssVllm = () => ({
  id: 'gpt-oss-vllm',
  modelId: 'openai/gpt-oss-20b',
  url: 'http://hal9000:1897/v1/chat/completions',
  provider: 'openai',
  enabled: true
});
const shippedFlashLatest = () => ({
  id: 'gemini-flash-latest',
  modelId: 'gemini-flash-latest',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent',
  provider: 'google',
  enabled: true,
  thinking: { enabled: true, budget: -1, thoughts: true }
});

test('version is the next unused number', () => {
  assert.equal(version, '089');
});

test('precondition only runs on an installed instance', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('deletes retired models that still match the shipped default', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gpt-4.json': shippedGpt4(),
    'models/gpt-oss-vllm.json': shippedGptOssVllm()
  });

  await up(ctx);

  assert.equal(ctx.files['models/gpt-4.json'], undefined);
  assert.equal(ctx.files['models/gpt-oss-vllm.json'], undefined);
  assert.ok(ctx.deletes.includes('models/gpt-4.json'));
  assert.ok(ctx.deletes.includes('models/gpt-oss-vllm.json'));
});

test('keeps a customized retired model but disables it', async () => {
  const custom = { ...shippedGptOssVllm(), url: 'http://my-own-vllm.internal:8000/v1/chat' };
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gpt-oss-vllm.json': custom
  });

  await up(ctx);

  assert.ok(ctx.files['models/gpt-oss-vllm.json'], 'customized model must not be deleted');
  assert.equal(ctx.files['models/gpt-oss-vllm.json'].enabled, false);
  assert.equal(
    ctx.files['models/gpt-oss-vllm.json'].url,
    'http://my-own-vllm.internal:8000/v1/chat'
  );
  assert.equal(ctx.deletes.includes('models/gpt-oss-vllm.json'), false);
  // No marker field: the model schema is strict and would warn on every boot.
  assert.deepEqual(
    Object.keys(ctx.files['models/gpt-oss-vllm.json']).filter(k => !(k in custom)),
    []
  );
});

test('repoints apps that referenced a deleted model', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gpt-oss-vllm.json': shippedGptOssVllm(),
    'models/claude-4-sonnet.json': {
      id: 'claude-4-sonnet',
      modelId: 'claude-sonnet-4-6',
      url: 'https://api.anthropic.com/v1/messages',
      provider: 'anthropic'
    },
    'apps/nda.json': { id: 'nda', preferredModel: 'gpt-oss-vllm' },
    'apps/legal.json': {
      id: 'legal',
      allowedModels: ['claude-4-sonnet', 'gemini-flash-latest']
    },
    'apps/other.json': { id: 'other', preferredModel: 'gemini-flash-latest' }
  });

  await up(ctx);

  assert.equal(ctx.files['apps/nda.json'].preferredModel, 'gemini-flash-latest');
  assert.deepEqual(ctx.files['apps/legal.json'].allowedModels, [
    'claude-sonnet-5',
    'gemini-flash-latest'
  ]);
  assert.equal(ctx.files['apps/other.json'].preferredModel, 'gemini-flash-latest');
  assert.equal(ctx.writes.includes('apps/other.json'), false, 'untouched app must not be written');
});

test('does not repoint apps when the retired model was kept', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gpt-oss-vllm.json': { ...shippedGptOssVllm(), url: 'http://mine:8000/v1/chat' },
    'apps/nda.json': { id: 'nda', preferredModel: 'gpt-oss-vllm' }
  });

  await up(ctx);

  assert.equal(ctx.files['apps/nda.json'].preferredModel, 'gpt-oss-vllm');
});

test('rewrites the Gemini 2.5 thinking shape to thinking.level', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gemini-flash-latest.json': shippedFlashLatest()
  });

  await up(ctx);

  const model = ctx.files['models/gemini-flash-latest.json'];
  assert.deepEqual(model.thinking, { enabled: true, level: 'medium' });
  assert.equal('budget' in model.thinking, false);
  assert.equal('thoughts' in model.thinking, false);
});

test('leaves an admin-chosen thinking level alone', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gemini-flash-latest.json': {
      ...shippedFlashLatest(),
      thinking: { enabled: true, level: 'low' }
    }
  });

  await up(ctx);

  assert.deepEqual(ctx.files['models/gemini-flash-latest.json'].thinking, {
    enabled: true,
    level: 'low'
  });
});

test('promotes the Nano Banana preview ids to their stable release', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/gemini-3.1-flash-image.json': {
      id: 'gemini-3.1-flash-image',
      modelId: 'gemini-3.1-flash-image-preview',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:streamGenerateContent',
      provider: 'google',
      thinking: { enabled: true, budget: -1, thoughts: true }
    },
    'models/gemini-3-pro-image.json': {
      id: 'gemini-3-pro-image',
      modelId: 'gemini-3-pro-image',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:streamGenerateContent',
      provider: 'google',
      thinking: { enabled: true, budget: -1, thoughts: true }
    }
  });

  await up(ctx);

  const flashImage = ctx.files['models/gemini-3.1-flash-image.json'];
  assert.equal(flashImage.modelId, 'gemini-3.1-flash-image');
  assert.ok(!flashImage.url.includes('-preview'));
  assert.equal(flashImage.thinking.level, 'low');

  const proImage = ctx.files['models/gemini-3-pro-image.json'];
  assert.ok(!proImage.url.includes('-preview'));
  assert.equal(proImage.thinking.level, 'high');
});

test('seeds the new models from the real shipped defaults', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} });

  await up(ctx);

  for (const id of [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5-1',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite-image',
    'gemini-3.5-transcribe-live',
    'gemini-3.5-transcribe'
  ]) {
    assert.ok(ctx.files[`models/${id}.json`], `expected models/${id}.json to be seeded`);
    assert.equal(ctx.files[`models/${id}.json`].id, id);
  }
  // Anthropic's newer models must ship with sampling parameters turned off, or
  // every request 400s.
  assert.equal(ctx.files['models/claude-opus-5.json'].supportsTemperature, false);
  assert.equal(ctx.files['models/claude-sonnet-5.json'].supportsTemperature, false);
  assert.equal(ctx.files['models/claude-fable-5-1.json'].supportsTemperature, false);
  // The Gemini transcription models must never be enabled without an explicit
  // opt-in: enabling them sends audio to Google.
  assert.equal(ctx.files['models/gemini-3.5-transcribe-live.json'].enabled, false);
  assert.equal(ctx.files['models/gemini-3.5-transcribe.json'].enabled, false);
});

test('never overwrites an existing model file with the same id', async () => {
  const mine = { id: 'claude-opus-5', modelId: 'my-proxy', url: 'https://proxy.internal/v1' };
  const ctx = fakeCtx({
    'config/platform.json': {},
    'models/claude-opus-5.json': { ...mine }
  });

  await up(ctx);

  assert.deepEqual(ctx.files['models/claude-opus-5.json'], mine);
});

test('is idempotent', async () => {
  const files = {
    'config/platform.json': {},
    'models/gpt-4.json': shippedGpt4(),
    'models/gemini-flash-latest.json': shippedFlashLatest(),
    'apps/nda.json': { id: 'nda', preferredModel: 'gpt-4' }
  };
  const first = fakeCtx(files);
  await up(first);
  const afterFirst = JSON.parse(JSON.stringify(files));

  const second = fakeCtx(files);
  await up(second);

  assert.deepEqual(files, afterFirst);
  assert.deepEqual(second.writes, [], 'a second run must not rewrite anything');
  assert.deepEqual(second.deletes, []);
});
