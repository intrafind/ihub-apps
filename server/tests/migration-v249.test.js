// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V249 specs — the default refresh TTL of project items is a week.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V249__project_refresh_week.js';

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is 249', () => {
  assert.equal(version, '249');
});

test('precondition needs platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('turns the day V237 wrote into a week', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { projects: { refreshTtl: 86400, limits: {} } } });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].projects, {
    refreshTtl: 604800,
    limits: {}
  });
});

test('keeps any other value', async () => {
  for (const refreshTtl of [3600, 2592000, 'never']) {
    const ctx = fakeCtx({ 'config/platform.json': { projects: { refreshTtl } } });
    await up(ctx);
    assert.equal(ctx.files['config/platform.json'].projects.refreshTtl, refreshTtl);
  }
});

test('writes nothing without a projects block or a TTL', async () => {
  for (const platform of [{}, { projects: {} }]) {
    let written = false;
    const ctx = fakeCtx({ 'config/platform.json': platform });
    ctx.writeJson = async () => {
      written = true;
    };
    await up(ctx);
    assert.equal(written, false);
  }
});

test('is idempotent', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { projects: { refreshTtl: 86400 } } });
  await up(ctx);
  await up(ctx);
  assert.equal(ctx.files['config/platform.json'].projects.refreshTtl, 604800);
});
