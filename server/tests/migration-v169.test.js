#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V169 specs — no app below temperature 0.7, no thinking for the
 * Translator and Babelfish.
 *
 * What these pin is restraint as much as reach: values at or above 0.7 and an
 * explicit `thinking` choice by the admin stay as they are, and other apps
 * never get a `thinking` block.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  version,
  description
} from '../migrations/V169__app_temperature_floor_and_translation_thinking.js';

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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v169-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('V169 metadata', () => {
  it('declares its version and description', () => {
    assert.equal(version, '169');
    assert.equal(description, 'app_temperature_floor_and_translation_thinking');
  });
});

describe('V169 temperature floor', () => {
  it('raises a temperature below 0.7 to 0.7', async () => {
    await writeApp({ id: 'mermaid', preferredTemperature: 0.3 });
    await up(makeCtx(dir));
    assert.equal((await readApp('mermaid')).preferredTemperature, 0.7);
  });

  it('leaves 0.7 and above, and apps without a temperature, alone', async () => {
    await writeApp({ id: 'chat', preferredTemperature: 0.7 });
    await writeApp({ id: 'web', preferredTemperature: 1 });
    await writeApp({ id: 'plain' });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal((await readApp('chat')).preferredTemperature, 0.7);
    assert.equal((await readApp('web')).preferredTemperature, 1);
    assert.equal('preferredTemperature' in (await readApp('plain')), false);
    assert.deepEqual(ctx.logs.at(-1), ['info', 'No app needed a change']);
  });
});

describe('V169 thinking for translation apps', () => {
  it('turns thinking off for the Translator and Babelfish', async () => {
    await writeApp({ id: 'translator', preferredTemperature: 0.3 });
    await writeApp({ id: 'babelfish', preferredTemperature: 0.2 });
    await up(makeCtx(dir));
    for (const id of ['translator', 'babelfish']) {
      const app = await readApp(id);
      assert.deepEqual(app.thinking, { enabled: false });
      assert.equal(app.preferredTemperature, 0.7);
    }
  });

  it('keeps the rest of an existing thinking block', async () => {
    await writeApp({ id: 'babelfish', thinking: { thoughts: true } });
    await up(makeCtx(dir));
    assert.deepEqual((await readApp('babelfish')).thinking, { thoughts: true, enabled: false });
  });

  it('keeps an explicit choice by the admin', async () => {
    await writeApp({ id: 'translator', thinking: { enabled: true, level: 'low' } });
    await up(makeCtx(dir));
    assert.deepEqual((await readApp('translator')).thinking, { enabled: true, level: 'low' });
  });

  it('does not add thinking to other apps', async () => {
    await writeApp({ id: 'summarizer', preferredTemperature: 0.3 });
    await up(makeCtx(dir));
    assert.equal('thinking' in (await readApp('summarizer')), false);
  });
});

describe('V169 robustness', () => {
  it('skips an unreadable app and still migrates the others', async () => {
    await fs.writeFile(path.join(dir, 'apps', 'broken.json'), '{ not json', 'utf8');
    await writeApp({ id: 'translator', preferredTemperature: 0.3 });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('apps/broken.json')));
    assert.equal((await readApp('translator')).preferredTemperature, 0.7);
  });

  it('changes nothing on a second run', async () => {
    await writeApp({ id: 'babelfish', preferredTemperature: 0.2 });
    await up(makeCtx(dir));
    const first = await readApp('babelfish');
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(await readApp('babelfish'), first);
    assert.deepEqual(ctx.logs.at(-1), ['info', 'No app needed a change']);
  });
});
