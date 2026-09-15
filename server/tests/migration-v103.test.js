#!/usr/bin/env node

/**
 * Migration V103 specs — image models get room, and lose `imageSize`.
 *
 * Two invariants carry the weight here. The installation-wide ceiling moves
 * only when it is still the number V095 seeded, so an operator who already
 * tuned it is not quietly overridden; and the `imageSize` → `quality`
 * conversion must leave no `imageSize` behind at all, because the model schema
 * is `.strict()` and a leftover key fails validation outright — which is the
 * bug this migration exists to clear.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V103__image_model_transport_and_quality.js';

let dir;

/** A migration context over a scratch contents directory. */
function makeCtx(base) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(base, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(base, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
      await fs.writeFile(path.join(base, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    listFiles: async (subdir, pattern) => {
      const entries = await fs.readdir(path.join(base, subdir)).catch(() => []);
      if (!pattern) return entries;
      // Same glob→regex conversion the real runner does, escaping every regex
      // metacharacter (the backslash included) before `*` becomes `.*`. Escaping
      // only `.`, as this stub first did, leaves a backslash in the pattern free
      // to alter the regex it lands in.
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`);
      return entries.filter(e => regex.test(e));
    },
    setDefault: (obj, dotPath, value) => {
      const keys = dotPath.split('.');
      const last = keys.pop();
      let cur = obj;
      for (const k of keys) {
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
      }
      if (Object.prototype.hasOwnProperty.call(cur, last)) return false;
      cur[last] = value;
      return true;
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function writeModel(id, model) {
  await fs.mkdir(path.join(dir, 'models'), { recursive: true });
  await fs.writeFile(path.join(dir, `models/${id}.json`), JSON.stringify(model, null, 2), 'utf8');
}

async function readModel(id) {
  return JSON.parse(await fs.readFile(path.join(dir, `models/${id}.json`), 'utf8'));
}

async function writePlatform(platform) {
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/platform.json'),
    JSON.stringify(platform, null, 2),
    'utf8'
  );
}

async function readPlatform() {
  return JSON.parse(await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8'));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v103-'));
  await fs.mkdir(path.join(dir, 'models'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('V103 metadata', () => {
  it('declares its version and description', () => {
    assert.equal(version, '103');
    assert.equal(description, 'image_model_transport_and_quality');
  });
});

describe('V103 — installation-wide connect ceiling', () => {
  it('raises the superseded 10s default to 30s', async () => {
    await writePlatform({ llm: { connectTimeoutMs: 10000, streamIdleTimeoutMs: 60000 } });

    await up(makeCtx(dir));

    const platform = await readPlatform();
    assert.equal(platform.llm.connectTimeoutMs, 30000);
    assert.equal(platform.llm.streamIdleTimeoutMs, 60000, 'unrelated ceiling untouched');
  });

  it('leaves a ceiling the operator tuned alone', async () => {
    await writePlatform({ llm: { connectTimeoutMs: 120000 } });

    await up(makeCtx(dir));

    assert.equal((await readPlatform()).llm.connectTimeoutMs, 120000);
  });

  it('leaves a deliberately disabled ceiling disabled', async () => {
    await writePlatform({ llm: { connectTimeoutMs: 0 } });

    await up(makeCtx(dir));

    assert.equal(
      (await readPlatform()).llm.connectTimeoutMs,
      0,
      '0 disables the ceiling and is a choice, not an unset value'
    );
  });

  it('seeds the key when the llm block is absent entirely', async () => {
    await writePlatform({ features: {} });

    await up(makeCtx(dir));

    const platform = await readPlatform();
    assert.equal(platform.llm.connectTimeoutMs, 30000);
    assert.deepEqual(platform.features, {}, 'rest of platform.json preserved');
  });

  it('does not fail when there is no platform.json yet', async () => {
    await writeModel('gemini-3-pro-image', {
      id: 'gemini-3-pro-image',
      supportsImageGeneration: true
    });

    await up(makeCtx(dir));

    assert.equal((await readModel('gemini-3-pro-image')).connectTimeoutMs, 60000);
  });
});

describe('V103 — per-model ceiling for image models', () => {
  beforeEach(async () => {
    await writePlatform({ llm: { connectTimeoutMs: 10000 } });
  });

  it('gives an image-generation model 60s of its own', async () => {
    await writeModel('gemini-3-pro-image', {
      id: 'gemini-3-pro-image',
      provider: 'google',
      supportsImageGeneration: true
    });

    await up(makeCtx(dir));

    assert.equal((await readModel('gemini-3-pro-image')).connectTimeoutMs, 60000);
  });

  it('leaves text models on the installation default', async () => {
    await writeModel('gemini-3.1-pro', { id: 'gemini-3.1-pro', supportsImageGeneration: false });
    await writeModel('claude-opus-5', { id: 'claude-opus-5' });

    await up(makeCtx(dir));

    assert.equal((await readModel('gemini-3.1-pro')).connectTimeoutMs, undefined);
    assert.equal((await readModel('claude-opus-5')).connectTimeoutMs, undefined);
  });

  it('does not overwrite a ceiling the operator already set on the model', async () => {
    await writeModel('gemini-3-pro-image', {
      id: 'gemini-3-pro-image',
      supportsImageGeneration: true,
      connectTimeoutMs: 90000
    });

    await up(makeCtx(dir));

    assert.equal((await readModel('gemini-3-pro-image')).connectTimeoutMs, 90000);
  });

  it('skips an unparseable model file instead of aborting the run', async () => {
    await fs.writeFile(path.join(dir, 'models/broken.json'), '{ not json', 'utf8');
    await writeModel('gemini-3-pro-image', {
      id: 'gemini-3-pro-image',
      supportsImageGeneration: true
    });

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal((await readModel('gemini-3-pro-image')).connectTimeoutMs, 60000);
    assert.ok(
      ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')),
      'the skipped file is reported'
    );
  });
});

describe('V103 — imageSize becomes quality', () => {
  beforeEach(async () => {
    await writePlatform({ llm: { connectTimeoutMs: 10000 } });
  });

  for (const [size, quality] of [
    ['1K', 'Low'],
    ['2K', 'Medium'],
    ['4K', 'High']
  ]) {
    it(`converts ${size} to ${quality} and removes the rejected key`, async () => {
      await writeModel('img', {
        id: 'img',
        supportsImageGeneration: true,
        imageGeneration: { aspectRatio: '16:9', imageSize: size, maxReferenceImages: 14 }
      });

      await up(makeCtx(dir));

      const { imageGeneration } = await readModel('img');
      assert.equal(imageGeneration.quality, quality);
      assert.ok(!('imageSize' in imageGeneration), 'imageSize would fail the strict schema');
      assert.equal(imageGeneration.aspectRatio, '16:9', 'sibling keys preserved');
      assert.equal(imageGeneration.maxReferenceImages, 14);
    });
  }

  it('keeps an existing quality and still drops imageSize', async () => {
    await writeModel('img', {
      id: 'img',
      supportsImageGeneration: true,
      imageGeneration: { quality: 'High', imageSize: '1K' }
    });

    await up(makeCtx(dir));

    const { imageGeneration } = await readModel('img');
    assert.equal(imageGeneration.quality, 'High', 'quality is what the adapter reads');
    assert.ok(!('imageSize' in imageGeneration));
  });

  it('drops an unrecognised imageSize and warns rather than inventing a quality', async () => {
    await writeModel('img', {
      id: 'img',
      supportsImageGeneration: true,
      imageGeneration: { imageSize: '8K' }
    });

    const ctx = makeCtx(dir);
    await up(ctx);

    const { imageGeneration } = await readModel('img');
    assert.ok(!('imageSize' in imageGeneration));
    assert.equal(imageGeneration.quality, undefined, 'left to the schema default');
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('8K')));
  });

  it('leaves a model without an imageGeneration block untouched', async () => {
    await writeModel('text', { id: 'text', provider: 'google' });

    await up(makeCtx(dir));

    assert.deepEqual(await readModel('text'), { id: 'text', provider: 'google' });
  });

  it('is idempotent', async () => {
    await writeModel('img', {
      id: 'img',
      supportsImageGeneration: true,
      imageGeneration: { aspectRatio: '1:1', imageSize: '2K' }
    });

    await up(makeCtx(dir));
    const first = await readModel('img');
    await up(makeCtx(dir));

    assert.deepEqual(await readModel('img'), first);
  });
});

describe('V103 — a fresh install that already ships the new default', () => {
  it('is a no-op on the ceiling, not a "tuned" report', async () => {
    await writePlatform({ llm: { connectTimeoutMs: 30000 } });

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal((await readPlatform()).llm.connectTimeoutMs, 30000);
    assert.ok(
      !ctx.logs.some(([, m]) => m.includes('tuned for this installation')),
      'the shipped default is not an operator override'
    );
  });
});
