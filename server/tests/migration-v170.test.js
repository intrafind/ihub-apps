#!/usr/bin/env node

/**
 * Migration V170 specs — skills are opt-in per app.
 *
 * Apps that list skills and the general-purpose chat apps keep them; every
 * other app stays off, and an explicit choice by the admin is never changed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V170__enable_skills_per_app.js';

let dir = '';

/** A migration context over a scratch contents directory. */
function makeCtx(base) {
  const logs = [];
  return {
    logs,
    readJson: async rel => JSON.parse(await fs.readFile(path.join(base, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(base, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    listFiles: async (subdir, pattern) => {
      const entries = await fs.readdir(path.join(base, subdir)).catch(() => []);
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return entries.filter(e => new RegExp(`^${escaped}$`).test(e));
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function writeApp(app) {
  await fs.writeFile(path.join(dir, 'apps', `${app.id}.json`), JSON.stringify(app), 'utf8');
}

async function readApp(id) {
  return JSON.parse(await fs.readFile(path.join(dir, 'apps', `${id}.json`), 'utf8'));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v170-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('migration V170', () => {
  it('declares its version and description', () => {
    assert.equal(version, '170');
    assert.equal(description, 'enable_skills_per_app');
  });

  it('enables skills on apps that list skills', async () => {
    await writeApp({
      id: 'research',
      skills: ['summarize'],
      skillSettings: { allowPersonal: false }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readApp('research')).skillSettings, {
      allowPersonal: false,
      enabled: true
    });
  });

  it('enables skills on the general-purpose chat apps', async () => {
    for (const id of ['chat', 'web-chat', 'iassistant']) await writeApp({ id, tools: [] });
    await up(makeCtx(dir));
    for (const id of ['chat', 'web-chat', 'iassistant']) {
      assert.equal((await readApp(id)).skillSettings.enabled, true, id);
    }
  });

  it('leaves every other app off', async () => {
    await writeApp({ id: 'babelfish', tools: [], skills: [] });
    await writeApp({ id: 'translator' });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(!('skillSettings' in (await readApp('babelfish'))));
    assert.ok(!('skillSettings' in (await readApp('translator'))));
    assert.ok(ctx.logs.some(([, m]) => m.includes('apps/babelfish.json: skills stay off')));
  });

  it('keeps an explicit choice, either way', async () => {
    await writeApp({ id: 'chat', skillSettings: { enabled: false } });
    await writeApp({ id: 'other', skills: ['x'], skillSettings: { enabled: false } });
    await up(makeCtx(dir));
    assert.equal((await readApp('chat')).skillSettings.enabled, false);
    assert.equal((await readApp('other')).skillSettings.enabled, false);
  });

  it('logs each decision and skips unreadable files', async () => {
    await fs.writeFile(path.join(dir, 'apps', 'broken.json'), '{ nope', 'utf8');
    await writeApp({ id: 'chat' });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')));
    assert.ok(ctx.logs.some(([, m]) => m.includes('apps/chat.json: skillSettings.enabled set')));
    assert.equal((await readApp('chat')).skillSettings.enabled, true);
  });
});
