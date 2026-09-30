#!/usr/bin/env node

/**
 * Migration V136 specs — `[content]` becomes `{{content}}` in prompt texts.
 *
 * The prompt library has one placeholder syntax now (#2519). Every language of
 * a prompt's `prompt` text is rewritten; nothing else in the file changes, and
 * a file without the old placeholder is not written at all.
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
  migratePromptText
} from '../migrations/V136__prompt_content_placeholder.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    listFiles: async (rel, pattern) => {
      const entries = await fs.readdir(path.join(dir, rel)).catch(() => []);
      return pattern === '*.json' ? entries.filter(entry => entry.endsWith('.json')) : entries;
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes.push(rel);
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed(files) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v136-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(
      path.join(dir, rel),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8'
    );
  }
  return { dir, ctx: makeCtx(dir) };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v136-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V136 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '136');
    assert.equal(description, 'prompt_content_placeholder');
  });

  it('only runs when there are prompts', async () => {
    const { ctx: none } = await seed({ 'config/platform.json': {} });
    assert.equal(await precondition(none), false);
    const { ctx } = await seed({ 'prompts/a.json': { id: 'a' } });
    assert.equal(await precondition(ctx), true);
  });
});

describe('V136 rewrites the placeholder', () => {
  it('replaces every occurrence in every language', () => {
    assert.deepEqual(
      migratePromptText({ en: 'A [content] B [content]', de: 'C [content]', fr: 'none' }),
      { en: 'A {{content}} B {{content}}', de: 'C {{content}}', fr: 'none' }
    );
    assert.equal(migratePromptText('x [content]'), 'x {{content}}');
    assert.equal(migratePromptText({ en: 'nothing' }), null);
    assert.equal(migratePromptText(null), null);
  });

  it('writes only the files that used it, and nothing else in them', async () => {
    const { ctx } = await seed({
      'prompts/summarize.json': {
        id: 'summarize',
        name: { en: 'Summarize [content]' },
        prompt: { en: 'Summarize: [content]', de: 'Fasse zusammen: [content]' },
        variables: [{ name: 'content', label: { en: '[content]' } }]
      },
      'prompts/plain.json': { id: 'plain', prompt: { en: 'Already {{content}}' } },
      'prompts/broken.json': '{ not json'
    });
    await up(ctx);
    const summarize = await ctx.readJson('prompts/summarize.json');
    assert.deepEqual(summarize.prompt, {
      en: 'Summarize: {{content}}',
      de: 'Fasse zusammen: {{content}}'
    });
    assert.equal(summarize.name.en, 'Summarize [content]', 'only the prompt text changes');
    assert.equal(summarize.variables[0].label.en, '[content]');
    assert.deepEqual(ctx.writes, ['prompts/summarize.json']);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')));
  });

  it('rewrites the legacy prompts.json too', async () => {
    const { ctx } = await seed({
      'config/prompts.json': [{ id: 'a', prompt: { en: 'Go [content]' } }, { id: 'b' }]
    });
    await up(ctx);
    const legacy = await ctx.readJson('config/prompts.json');
    assert.equal(legacy[0].prompt.en, 'Go {{content}}');
    assert.deepEqual(legacy[1], { id: 'b' });
  });

  it('is idempotent', async () => {
    const { ctx } = await seed({ 'prompts/a.json': { id: 'a', prompt: { en: 'x [content]' } } });
    await up(ctx);
    ctx.writes.length = 0;
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  });
});
