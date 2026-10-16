#!/usr/bin/env node

/**
 * Migration V167 specs — the per-app `transcription` block and the platform's
 * `speech.transcription` are removed; a restricted `allowedModels` keeps the
 * transcription model the app used.
 *
 * Run: node --test server/tests/migration-v167.test.js
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V167__remove_app_transcription_pipeline.js';

let baseDir = null;

function makeCtx(dir) {
  const writes = [];
  return {
    writes,
    fileExists: async rel =>
      fs.access(path.join(dir, rel)).then(
        () => true,
        () => false
      ),
    listFiles: async directory => {
      try {
        return (await fs.readdir(path.join(dir, directory))).filter(n => n.endsWith('.json'));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes.push(rel);
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: () => {},
    warn: () => {}
  };
}

async function freshDir(apps, platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  for (const [name, app] of Object.entries(apps)) {
    const text = typeof app === 'string' ? app : JSON.stringify(app);
    await fs.writeFile(path.join(dir, 'apps', name), text, 'utf8');
  }
  if (platform) {
    await fs.writeFile(path.join(dir, 'config', 'platform.json'), JSON.stringify(platform));
  }
  return dir;
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v167-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V167 remove the per-app transcription pipeline', () => {
  it('exports its version and description', () => {
    assert.equal(version, '167');
    assert.equal(description, 'remove_app_transcription_pipeline');
  });

  it('appends the app model, else the platform default, to a restricted allowedModels', async () => {
    const dir = await freshDir(
      {
        'own.json': {
          id: 'own',
          allowedModels: ['gpt'],
          transcription: { enabled: true, modelId: 'whisper' }
        },
        'platform.json': {
          id: 'platform',
          allowedModels: ['gpt'],
          transcription: { enabled: true, modelId: '' }
        },
        'already.json': {
          id: 'already',
          allowedModels: ['gpt', 'whisper'],
          transcription: { enabled: true, modelId: 'whisper' }
        },
        'open.json': { id: 'open', transcription: { enabled: true, modelId: 'whisper' } },
        'empty.json': {
          id: 'empty',
          allowedModels: [],
          transcription: { enabled: true, modelId: 'whisper' }
        },
        'off.json': {
          id: 'off',
          allowedModels: ['gpt'],
          transcription: { enabled: false, modelId: 'whisper' }
        }
      },
      {
        speech: {
          defaultService: 'model',
          dictation: { modelId: 'd' },
          transcription: { defaultModelId: 'voxtral' }
        }
      }
    );

    await up(makeCtx(dir));

    assert.deepEqual(await read(dir, 'apps/own.json'), {
      id: 'own',
      allowedModels: ['gpt', 'whisper']
    });
    assert.deepEqual(await read(dir, 'apps/platform.json'), {
      id: 'platform',
      allowedModels: ['gpt', 'voxtral']
    });
    assert.deepEqual((await read(dir, 'apps/already.json')).allowedModels, ['gpt', 'whisper']);
    assert.deepEqual(await read(dir, 'apps/open.json'), { id: 'open' });
    assert.deepEqual(await read(dir, 'apps/empty.json'), { id: 'empty', allowedModels: [] });
    assert.deepEqual(await read(dir, 'apps/off.json'), { id: 'off', allowedModels: ['gpt'] });
    assert.deepEqual(await read(dir, 'config/platform.json'), {
      speech: { defaultService: 'model', dictation: { modelId: 'd' } }
    });
  });

  it('is idempotent and skips unreadable files', async () => {
    const dir = await freshDir(
      { 'plain.json': { id: 'plain' }, 'broken.json': '{ not json' },
      { speech: { defaultService: 'browser' } }
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  });

  it('runs without a platform.json', async () => {
    const dir = await freshDir({ 'a.json': { id: 'a', transcription: { enabled: true } } });
    await up(makeCtx(dir));
    assert.deepEqual(await read(dir, 'apps/a.json'), { id: 'a' });
  });
});
