#!/usr/bin/env node

/**
 * Migration V091 specs — seeding `startPage.defaultPage` in ui.json.
 *
 * Admins can now choose what the "/" route shows. The migration writes the
 * behaviour installs already have ("start"), so upgrading changes nothing on
 * screen; the two id fields it deliberately leaves out only matter once an
 * admin picks a page or an app.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V091__add_default_start_page.js';
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
  assert.equal(version, '091');
});

test('precondition is false when ui.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/ui.json': {} })), true);
});

test('an install without the setting keeps the start page as home', async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      title: { en: 'iHub Apps' },
      startPage: { showDefaultApp: true, subtitle: { en: 'How can I help you today?' } }
    }
  });

  await up(ctx);
  const { startPage } = ctx.files['config/ui.json'];

  assert.equal(startPage.defaultPage, 'start');
  // The targets only apply to the other choices, so they stay unset.
  assert.equal('defaultPageId' in startPage, false);
  assert.equal('defaultPageAppId' in startPage, false);
  // Everything V090 seeded survives untouched.
  assert.equal(startPage.showDefaultApp, true);
  assert.deepEqual(startPage.subtitle, { en: 'How can I help you today?' });
  assert.deepEqual(ctx.files['config/ui.json'].title, { en: 'iHub Apps' });
  assert.ok(ctx.logs.some(l => l.includes('startPage.defaultPage')));
});

test('the section is created when ui.json has none', async () => {
  const ctx = fakeCtx({ 'config/ui.json': { title: {}, header: {} } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/ui.json'].startPage, { defaultPage: 'start' });
});

test("an admin's existing choice wins over the default", async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      startPage: { defaultPage: 'page', defaultPageId: 'welcome' }
    }
  });

  await up(ctx);
  const { startPage } = ctx.files['config/ui.json'];

  assert.equal(startPage.defaultPage, 'page');
  assert.equal(startPage.defaultPageId, 'welcome');
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx({ 'config/ui.json': { title: {}, startPage: {} } });
  await up(ctx);
  const once = JSON.stringify(ctx.files['config/ui.json']);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['config/ui.json']), once);
});
