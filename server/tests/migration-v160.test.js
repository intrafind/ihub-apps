#!/usr/bin/env node

/**
 * Migration V160 specs — seeding `platform.aiTransparency` and the per-model
 * `contentMarking` block (EU AI Act Art. 50, issue #2563).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description,
  AI_TRANSPARENCY_DEFAULTS
} from '../migrations/V160__add_ai_transparency.js';
import { setDefault } from '../migrations/utils.js';
import { DEFAULT_AI_TRANSPARENCY } from '../../shared/aiTransparency.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    listFiles: async (rel, _glob) =>
      (await fs.readdir(path.join(dir, rel))).filter(f => f.endsWith('.json')),
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed({ platform = {}, models = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v160-'));
  if (platform !== null) {
    await fs.mkdir(path.join(dir, 'config'), { recursive: true });
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  if (models !== null) {
    await fs.mkdir(path.join(dir, 'models'), { recursive: true });
    for (const [id, model] of Object.entries(models)) {
      await fs.writeFile(path.join(dir, `models/${id}.json`), JSON.stringify(model), 'utf8');
    }
  }
  return { dir, ctx: makeCtx(dir) };
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value))
      Object.assign(out, flatten(value, p));
    else out[p] = value;
  }
  return out;
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v160-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V160 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '160');
    assert.equal(description, 'add_ai_transparency');
  });

  it('runs when platform.json or the models directory exists', async () => {
    const { ctx: none } = await seed({ platform: null, models: null });
    assert.equal(await precondition(none), false);
    const { ctx: both } = await seed();
    assert.equal(await precondition(both), true);
  });

  it('seeds exactly the shared defaults', () => {
    assert.deepEqual(AI_TRANSPARENCY_DEFAULTS, flatten(DEFAULT_AI_TRANSPARENCY));
  });
});

describe('V160 platform defaults', () => {
  it('adds the whole section to an installation that has none', async () => {
    const { ctx } = await seed({ platform: { auth: { mode: 'local' } } });
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.deepEqual(flatten(platform.aiTransparency), AI_TRANSPARENCY_DEFAULTS);
    assert.deepEqual(platform.auth, { mode: 'local' });
  });

  it('keeps values an admin already set', async () => {
    const { ctx } = await seed({
      platform: {
        aiTransparency: { detection: { access: 'public' }, images: { watermark: 'none' } }
      }
    });
    await up(ctx);
    const { aiTransparency } = await ctx.readJson('config/platform.json');
    assert.equal(aiTransparency.detection.access, 'public');
    assert.equal(aiTransparency.images.watermark, 'none');
    assert.equal(aiTransparency.images.c2pa, true);
    assert.equal(aiTransparency.interactionDisclosure.enabled, true);
  });

  it('is idempotent', async () => {
    const { ctx } = await seed();
    await up(ctx);
    const first = await ctx.readJson('config/platform.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/platform.json'), first);
  });
});

describe('V160 model contentMarking', () => {
  it('marks cloud text models as unmarked and Gemini images as SynthID', async () => {
    const { ctx } = await seed({
      models: {
        'claude-x': { id: 'claude-x', provider: 'anthropic' },
        'gemini-img': { id: 'gemini-img', provider: 'google', supportsImageGeneration: true },
        'gemini-txt': { id: 'gemini-txt', provider: 'google' }
      }
    });
    await up(ctx);
    assert.deepEqual((await ctx.readJson('models/claude-x.json')).contentMarking, {
      textWatermark: 'none'
    });
    assert.deepEqual((await ctx.readJson('models/gemini-img.json')).contentMarking, {
      textWatermark: 'none',
      imageWatermark: 'upstream:synthid'
    });
    assert.deepEqual((await ctx.readJson('models/gemini-txt.json')).contentMarking, {
      textWatermark: 'none'
    });
  });

  it('never overwrites an existing block and skips transcription models', async () => {
    const own = { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'acme' } };
    const { ctx } = await seed({
      models: {
        vllm: { id: 'vllm', provider: 'local', contentMarking: own },
        stt: { id: 'stt', provider: 'google-transcribe', modelType: 'transcription' }
      }
    });
    await up(ctx);
    assert.deepEqual((await ctx.readJson('models/vllm.json')).contentMarking, own);
    assert.equal((await ctx.readJson('models/stt.json')).contentMarking, undefined);
  });
});
