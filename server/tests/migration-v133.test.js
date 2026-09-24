#!/usr/bin/env node

/**
 * Migration V133 specs — the iHub Support Bot searches the documentation.
 *
 * The documentation source is too large to return whole, so its tool answers
 * a `query`. The bot's system prompt has to say so (and that the docs are in
 * English), or the bot never passes one. Each language is replaced only while
 * it still reads as shipped; anything an admin wrote stays.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description,
  SYSTEM,
  PREVIOUS_SYSTEM
} from '../migrations/V133__support_bot_searches_documentation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_FILE = 'apps/ihub-support-bot.json';

let baseDir;

/** A migration context over a scratch contents directory. */
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
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a scratch contents dir holding this app config (`null`: no file). */
async function seed(app) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v133-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
  if (app !== null) {
    await fs.writeFile(path.join(dir, APP_FILE), JSON.stringify(app, null, 2), 'utf8');
  }
  return { dir, ctx: makeCtx(dir) };
}

/** The support bot as it shipped before V133. */
function supportBot(overrides = {}) {
  return {
    id: 'ihub-support-bot',
    name: { en: 'iHub Support Bot', de: 'iHub Support Bot' },
    system: { ...PREVIOUS_SYSTEM },
    sources: ['faq', 'ihub-documentation'],
    ...overrides
  };
}

const readApp = async dir => JSON.parse(await fs.readFile(path.join(dir, APP_FILE), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v133-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V133 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '133');
    assert.equal(description, 'support_bot_searches_documentation');
  });

  it('only runs when the support bot app exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
    const { ctx: withApp } = await seed(supportBot());
    assert.equal(await precondition(withApp), true);
  });

  it('matches what fresh installations ship', async () => {
    const shipped = JSON.parse(
      await fs.readFile(path.join(__dirname, '../defaults/apps/ihub-support-bot.json'), 'utf8')
    );
    assert.deepEqual(shipped.system, { ...SYSTEM });
  });

  it('tells the model to search with a query, in English, in every language', () => {
    for (const lang of ['en', 'de']) {
      assert.match(SYSTEM[lang], /`query`/);
      assert.match(SYSTEM[lang], /`section`/);
      assert.ok(SYSTEM[lang].endsWith('<sources>{{sources}}</sources>'));
    }
    assert.match(SYSTEM.en, /English terms/);
    assert.match(SYSTEM.de, /englischen Begriffen/);
  });
});

describe('V133 up', () => {
  it('replaces the shipped prompt in every language', async () => {
    const { dir, ctx } = await seed(supportBot());
    await up(ctx);
    const app = await readApp(dir);
    assert.deepEqual(app.system, { ...SYSTEM });
    assert.deepEqual(app.sources, ['faq', 'ihub-documentation']);
  });

  it('keeps a language an admin rewrote', async () => {
    const custom = 'Du bist unser eigener Support-Bot.\n\n<sources>{{sources}}</sources>';
    const { dir, ctx } = await seed(supportBot({ system: { ...PREVIOUS_SYSTEM, de: custom } }));
    await up(ctx);
    const app = await readApp(dir);
    assert.equal(app.system.en, SYSTEM.en);
    assert.equal(app.system.de, custom);
  });

  it('leaves a fully customized prompt, and a non-object one, untouched', async () => {
    for (const system of [{ en: 'Mine.' }, 'A plain string prompt']) {
      const { dir, ctx } = await seed(supportBot({ system }));
      const before = await fs.readFile(path.join(dir, APP_FILE), 'utf8');
      await up(ctx);
      assert.equal(await fs.readFile(path.join(dir, APP_FILE), 'utf8'), before);
    }
  });

  it('is idempotent', async () => {
    const { dir, ctx } = await seed(supportBot());
    await up(ctx);
    const once = await fs.readFile(path.join(dir, APP_FILE), 'utf8');
    await up(ctx);
    assert.equal(await fs.readFile(path.join(dir, APP_FILE), 'utf8'), once);
  });
});
