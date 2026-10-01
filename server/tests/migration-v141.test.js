#!/usr/bin/env node

/**
 * Migration V141 specs — provider names and descriptions become plain text.
 *
 * The admin Providers pages edit `name` and `description` as one string each.
 * Entries still carrying per-language objects are collapsed into the text in
 * the platform's default language, else English, else the first non-empty
 * one. Strings and every other field are left alone.
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
  toPlainText
} from '../migrations/V141__provider_plain_names.js';

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

async function freshDir(files) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  for (const [rel, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(data), 'utf8');
  }
  return dir;
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v141-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V141 provider_plain_names', () => {
  it('declares its version and description', () => {
    assert.equal(version, '141');
    assert.equal(description, 'provider_plain_names');
  });

  it('runs only when providers.json exists', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'config/providers.json': { providers: [] } });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('keeps the default-language text, else English, else the first value', () => {
    assert.equal(toPlainText({ en: 'Local LLM', de: 'Lokales LLM' }, 'de'), 'Lokales LLM');
    assert.equal(toPlainText({ en: 'Local LLM', de: 'Lokales LLM' }, 'fr'), 'Local LLM');
    assert.equal(toPlainText({ fr: 'Recherche' }, 'de'), 'Recherche');
    assert.equal(toPlainText({ en: '  ', de: 'Nur Deutsch' }, 'en'), 'Nur Deutsch');
    assert.equal(toPlainText('already text', 'en'), 'already text');
  });

  it('converts localized entries and leaves everything else on them alone', async () => {
    const dir = await freshDir({
      'config/platform.json': { defaultLanguage: 'de' },
      'config/providers.json': {
        providers: [
          {
            id: 'local',
            name: { en: 'Local LLM', de: 'Lokales LLM' },
            description: { en: 'Local providers', de: 'Lokale Anbieter' },
            enabled: true,
            apiKey: 'enc-secret'
          },
          {
            id: 'llmhub',
            name: 'T-Systems LLM Hub',
            description: 'Gateway',
            category: 'llm',
            apiType: 'openai'
          },
          { id: 'no-name', category: 'custom' }
        ]
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    const { providers } = await ctx.readJson('config/providers.json');

    assert.deepEqual(providers[0], {
      id: 'local',
      name: 'Lokales LLM',
      description: 'Lokale Anbieter',
      enabled: true,
      apiKey: 'enc-secret'
    });
    assert.deepEqual(providers[1], {
      id: 'llmhub',
      name: 'T-Systems LLM Hub',
      description: 'Gateway',
      category: 'llm',
      apiType: 'openai'
    });
    assert.equal(providers[2].name, 'no-name');
  });

  it('does not rewrite a file that is already plain text', async () => {
    const dir = await freshDir({
      'config/providers.json': { providers: [{ id: 'openai', name: 'OpenAI', description: '' }] }
    });
    const file = path.join(dir, 'config/providers.json');
    const before = await fs.readFile(file, 'utf8');
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.match(ctx.logs.at(-1)[1], /already plain text/);
  });
});
