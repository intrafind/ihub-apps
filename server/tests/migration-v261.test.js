#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V261 specs — the App Generator prompt
 * (`contents/prompts/app-generator.json`) is deleted, whether it is the
 * shipped copy or one an admin changed. Other prompts stay, a second run
 * changes nothing, and an installation without the file is skipped.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE,
  description,
  precondition,
  up,
  version
} from '../migrations/V261__remove_app_generator_prompt.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  const deleted = [];
  return {
    logs,
    deleted,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    deleteFile: async rel => {
      deleted.push(rel);
      await fs.unlink(path.join(dir, rel));
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

const exists = file =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

async function seed(prompts) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v261-'));
  await fs.mkdir(path.join(dir, 'prompts'), { recursive: true });
  for (const [name, data] of Object.entries(prompts)) {
    await fs.writeFile(path.join(dir, 'prompts', name), JSON.stringify(data, null, 2), 'utf8');
  }
  return dir;
}

const generatorPrompt = text => ({
  id: 'app-generator',
  name: { en: 'App Generator', de: 'App-Generator' },
  prompt: { en: text, de: text },
  category: 'system',
  enabled: true
});

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v261-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V261 remove_app_generator_prompt', () => {
  it('has the expected version and description', () => {
    assert.equal(version, '261');
    assert.equal(description, 'remove_app_generator_prompt');
    assert.equal(FILE, 'prompts/app-generator.json');
  });

  it('is skipped when the prompt file does not exist', async () => {
    const dir = await seed({ 'summarize.json': { id: 'summarize' } });
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('deletes the shipped copy and logs what it removed', async () => {
    const dir = await seed({
      'app-generator.json': generatorPrompt('You are an expert app generator.'),
      'summarize.json': { id: 'summarize' }
    });
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    assert.deepEqual(ctx.deleted, [FILE]);
    assert.equal(await exists(path.join(dir, FILE)), false);
    assert.ok(ctx.logs.some(([level, m]) => level === 'info' && m.includes(FILE)));
  });

  it('deletes a copy an admin customised as well', async () => {
    const dir = await seed({
      'app-generator.json': generatorPrompt('Our own brief: always answer formally.')
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await exists(path.join(dir, FILE)), false);
  });

  it('leaves every other prompt in place', async () => {
    const dir = await seed({
      'app-generator.json': generatorPrompt('x'),
      'summarize.json': { id: 'summarize' },
      'translate.json': { id: 'translate' }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await fs.readdir(path.join(dir, 'prompts'))).sort(), [
      'summarize.json',
      'translate.json'
    ]);
  });

  it('is idempotent: a second run is skipped and deletes nothing', async () => {
    const dir = await seed({ 'app-generator.json': generatorPrompt('x') });
    await up(makeCtx(dir));
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), false);
    await up(ctx);
    assert.deepEqual(ctx.deleted, []);
  });
});
