#!/usr/bin/env node

/**
 * Migration V092 specs — seeding the app-shortcut settings in ui.json.
 *
 * The start-page grid and the sidebar's Apps section are now configurable.
 * The migration writes the behaviour installs already have (four apps on the
 * start page, five in the sidebar, ranked by `order`, no curated defaults), so
 * upgrading changes nothing on screen — and it must never overwrite a value an
 * admin has already set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V092__add_app_shortcut_config.js';
import { setDefault } from '../migrations/utils.js';

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
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '092');
});

test('precondition is false when ui.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/ui.json': {} })), true);
});

test('an install without the settings gets the current behaviour spelled out', async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      title: { en: 'iHub Apps' },
      startPage: { defaultPage: 'start', showDefaultApp: true }
    }
  });

  await up(ctx);

  const { startPage } = ctx.files['config/ui.json'];
  assert.equal(startPage.appsMode, 'order');
  assert.equal(startPage.appsCount, 4);
  assert.equal(startPage.sidebarAppsCount, 5);
  assert.deepEqual(startPage.featuredAppIds, []);

  // Untouched: everything the earlier migrations seeded.
  assert.equal(startPage.defaultPage, 'start');
  assert.equal(startPage.showDefaultApp, true);
  assert.deepEqual(ctx.files['config/ui.json'].title, { en: 'iHub Apps' });
});

test('a ui.json without a startPage section gets the whole block', async () => {
  const ctx = fakeCtx({ 'config/ui.json': {} });

  await up(ctx);

  assert.deepEqual(ctx.files['config/ui.json'].startPage, {
    appsMode: 'order',
    appsCount: 4,
    sidebarAppsCount: 5,
    featuredAppIds: []
  });
});

test('values an admin already configured are preserved', async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      startPage: {
        appsMode: 'recent',
        appsCount: 8,
        sidebarAppsCount: 0,
        featuredAppIds: ['chat', 'translate']
      }
    }
  });

  await up(ctx);

  const { startPage } = ctx.files['config/ui.json'];
  assert.equal(startPage.appsMode, 'recent');
  assert.equal(startPage.appsCount, 8);
  assert.equal(startPage.sidebarAppsCount, 0);
  assert.deepEqual(startPage.featuredAppIds, ['chat', 'translate']);
});

test('a zero count is a real choice, not a missing value', async () => {
  // `setDefault` must treat 0 as set — otherwise "hide this list" would be
  // silently reverted to the default on every upgrade.
  const ctx = fakeCtx({ 'config/ui.json': { startPage: { appsCount: 0 } } });

  await up(ctx);

  assert.equal(ctx.files['config/ui.json'].startPage.appsCount, 0);
});

test('the migration reports what it did', async () => {
  const ctx = fakeCtx({ 'config/ui.json': {} });
  await up(ctx);
  assert.ok(ctx.logs.some(l => l.includes('startPage.appsMode')));
});
