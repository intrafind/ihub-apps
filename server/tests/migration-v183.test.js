#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V183 specs — the OpenRouter provider reaches existing installs,
 * without touching an `openrouter` entry an admin already created.
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
  description
} from '../migrations/V183__add_openrouter_llm_provider.js';

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
    readJson: async rel =>
      fs
        .readFile(path.join(dir, rel), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function setup(name, providers) {
  const dir = path.join(baseDir, name);
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (providers !== undefined) {
    await fs.writeFile(
      path.join(dir, 'config', 'providers.json'),
      JSON.stringify(providers === null ? {} : { providers }),
      'utf8'
    );
  }
  return dir;
}

const read = async dir =>
  JSON.parse(await fs.readFile(path.join(dir, 'config', 'providers.json'), 'utf8'));

describe('Migration V183 — OpenRouter LLM provider', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v183-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares version and description', () => {
    assert.equal(version, '183');
    assert.ok(description);
  });

  it('skips installs without providers.json', async () => {
    const dir = await setup('none');
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('adds the entry after the last LLM provider', async () => {
    const dir = await setup('fresh', [
      { id: 'openai', name: 'OpenAI', enabled: true },
      { id: 'bedrock', name: 'AWS Bedrock', enabled: true, category: 'llm' },
      { id: 'brave', name: 'Brave Search', enabled: true, category: 'websearch' }
    ]);
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const { providers } = await read(dir);
    assert.deepEqual(
      providers.map(p => p.id),
      ['openai', 'bedrock', 'openrouter', 'brave']
    );
    assert.deepEqual(providers[2], {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'OpenRouter — one API for models of many vendors',
      enabled: true,
      category: 'llm',
      apiType: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1'
    });
  });

  it('matches the shipped default entry', async () => {
    const defaults = JSON.parse(
      await fs.readFile(new URL('../defaults/config/providers.json', import.meta.url), 'utf8')
    );
    const dir = await setup('defaults', [{ id: 'openai', name: 'OpenAI', enabled: true }]);
    await up(makeCtx(dir));
    const added = (await read(dir)).providers.find(p => p.id === 'openrouter');
    assert.deepEqual(
      added,
      defaults.providers.find(p => p.id === 'openrouter')
    );
  });

  it('keeps an openrouter entry the admin already created', async () => {
    const existing = {
      id: 'openrouter',
      name: 'My OpenRouter',
      enabled: false,
      category: 'llm',
      apiType: 'openai',
      baseUrl: 'https://eu.openrouter.ai/api/v1',
      apiKey: 'ENC[...]'
    };
    const dir = await setup('existing', [{ id: 'openai', enabled: true }, existing]);
    await up(makeCtx(dir));
    const { providers } = await read(dir);
    assert.equal(providers.length, 2);
    assert.deepEqual(providers[1], existing);
  });

  it('warns and leaves a file without a providers array alone', async () => {
    const dir = await setup('broken', null);
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(await read(dir), {});
    assert.equal(ctx.logs[0][0], 'warn');
  });
});
