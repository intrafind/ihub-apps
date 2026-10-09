#!/usr/bin/env node

/**
 * Migration V162 specs — retiring the Playwright and Selenium screenshot tools.
 *
 * Exercised through a fake migration context so the real contents/ is never
 * touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V162__retire_screenshot_tools.js';

/** In-memory migration context mirroring the ctx surface V162 uses. */
function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => Object.prototype.hasOwnProperty.call(files, p),
    deleteFile: async p => {
      delete files[p];
    },
    log: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '162');
});

test('both screenshot tool files are deleted and other tools are kept', async () => {
  const ctx = fakeCtx({
    'tools/playwrightScreenshot.json': { id: 'playwrightScreenshot' },
    'tools/seleniumScreenshot.json': { id: 'seleniumScreenshot' },
    'tools/braveSearch.json': { id: 'braveSearch', script: 'braveSearch.js' }
  });

  assert.equal(await precondition(ctx), true);
  await up(ctx);

  assert.deepEqual(Object.keys(ctx.files), ['tools/braveSearch.json']);
  assert.match(ctx.logs[0], /Removed 2 retired screenshot tool/);
});

test('one remaining file is enough to run and is the only one removed', async () => {
  const ctx = fakeCtx({
    'tools/seleniumScreenshot.json': { id: 'seleniumScreenshot' },
    'tools/iFinder.json': { id: 'iFinder' }
  });

  assert.equal(await precondition(ctx), true);
  await up(ctx);

  assert.deepEqual(Object.keys(ctx.files), ['tools/iFinder.json']);
  assert.match(ctx.logs[0], /Removed 1 retired screenshot tool/);
});

test('is skipped when neither file exists (fresh install or already migrated)', async () => {
  const ctx = fakeCtx({ 'tools/braveSearch.json': { id: 'braveSearch' } });

  assert.equal(await precondition(ctx), false);
});
