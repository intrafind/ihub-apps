#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V184 specs — the built-in LLM providers get their API base URL,
 * without touching a URL an admin already set.
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
} from '../migrations/V184__add_llm_provider_base_urls.js';

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

describe('Migration V184 — base URLs for the built-in LLM providers', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v184-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares version and description', () => {
    assert.equal(version, '184');
    assert.ok(description);
  });

  it('skips installs without providers.json', async () => {
    const dir = await setup('none');
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('adds the base URLs of the shipped defaults to the built-in providers', async () => {
    const defaults = JSON.parse(
      await fs.readFile(new URL('../defaults/config/providers.json', import.meta.url), 'utf8')
    );
    const dir = await setup('fresh', [
      { id: 'openai', name: 'OpenAI', enabled: true },
      { id: 'anthropic', name: 'Anthropic', enabled: true },
      { id: 'google', name: 'Google', enabled: true },
      { id: 'mistral', name: 'Mistral AI', enabled: true },
      { id: 'local', name: 'Local LLM', enabled: true },
      { id: 'brave', name: 'Brave Search', enabled: true, category: 'websearch' }
    ]);
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const { providers } = await read(dir);
    for (const id of ['openai', 'anthropic', 'google', 'mistral']) {
      const expected = defaults.providers.find(p => p.id === id).baseUrl;
      assert.ok(expected, `default ${id} has a baseUrl`);
      assert.equal(providers.find(p => p.id === id).baseUrl, expected, id);
    }
    assert.equal(providers.find(p => p.id === 'local').baseUrl, undefined);
    assert.equal(providers.find(p => p.id === 'brave').baseUrl, undefined);
  });

  it('keeps a base URL the admin already set', async () => {
    const google = {
      id: 'google',
      name: 'Google',
      enabled: true,
      baseUrl: 'https://gemini-proxy.example.com/v1beta'
    };
    const dir = await setup('existing', [{ id: 'openai', enabled: true }, google]);
    await up(makeCtx(dir));
    const { providers } = await read(dir);
    assert.deepEqual(providers[1], google);
    assert.equal(providers[0].baseUrl, 'https://api.openai.com/v1');
  });

  it('does not rewrite the file when nothing changes', async () => {
    const dir = await setup('custom-only', [
      { id: 'llmhub', name: 'LLM Hub', category: 'llm', apiType: 'openai' }
    ]);
    const before = await fs.readFile(path.join(dir, 'config', 'providers.json'), 'utf8');
    await up(makeCtx(dir));
    assert.equal(await fs.readFile(path.join(dir, 'config', 'providers.json'), 'utf8'), before);
  });

  it('warns and leaves a file without a providers array alone', async () => {
    const dir = await setup('broken', null);
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(await read(dir), {});
    assert.equal(ctx.logs[0][0], 'warn');
  });
});
