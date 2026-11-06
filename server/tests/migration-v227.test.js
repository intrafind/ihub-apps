#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V227 specs — the ifinder-search app prompt stops asking for "more
 * specific terms" and says how to retry after zero hits, but only where an
 * admin has not reworded the prompt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  up,
  precondition,
  version,
  FRAGMENTS
} from '../migrations/V227__ifinder_zero_hit_retry_guidance.js';

const DEFAULTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../defaults');
const APP_FILE = 'apps/ifinder-search.json';

async function shipped(file) {
  return JSON.parse(await fs.readFile(path.join(DEFAULTS_DIR, file), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The app as an installation that predates this migration has it. */
async function installedApp() {
  const app = await shipped(APP_FILE);
  for (const [lang, { from, to }] of Object.entries(FRAGMENTS)) {
    assert.ok(app.system[lang].includes(to), `shipped ${lang} prompt carries the new bullets`);
    app.system[lang] = app.system[lang].replace(to, from);
  }
  return app;
}

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => clone(files[p]),
    readDefaultJson: shipped,
    writeJson: async (p, data) => {
      files[p] = data;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version', () => {
  assert.equal(version, '227');
});

test('precondition: skips installations without the app', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ [APP_FILE]: {} })), true);
});

test('an untouched prompt lands on the shipped default in every language', async () => {
  const ctx = fakeCtx({ [APP_FILE]: await installedApp() });
  await up(ctx);
  const expected = await shipped(APP_FILE);
  assert.deepEqual(ctx.files[APP_FILE].system, expected.system);
  assert.deepEqual(ctx.writes, [APP_FILE]);
  for (const lang of ['en', 'de']) {
    assert.ok(!ctx.files[APP_FILE].system[lang].includes(FRAGMENTS[lang].from));
  }
});

test('a customized prompt is left alone and the admin is told', async () => {
  const app = await installedApp();
  app.system.en = `${app.system.en}\n\nAlways answer in a friendly tone.`;
  const before = clone(app);
  const ctx = fakeCtx({ [APP_FILE]: app });
  await up(ctx);
  assert.equal(ctx.files[APP_FILE].system.en, before.system.en);
  assert.ok(ctx.logs.some(m => m.includes('system.en was customized')));
  // The untouched language is still refreshed.
  assert.equal(ctx.files[APP_FILE].system.de, (await shipped(APP_FILE)).system.de);
});

test('running twice changes nothing the second time', async () => {
  const ctx = fakeCtx({ [APP_FILE]: await installedApp() });
  await up(ctx);
  await up(ctx);
  assert.deepEqual(ctx.writes, [APP_FILE]);
});
