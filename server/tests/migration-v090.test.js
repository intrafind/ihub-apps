#!/usr/bin/env node

/**
 * Migration V090 specs — seeding the `startPage` section of ui.json.
 *
 * The "/" route became a start page whose behaviour lives in
 * `ui.json → startPage`. Existing installs have no such section, so the
 * migration seeds editable defaults without touching anything an admin set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V090__add_start_page_config.js';
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
  assert.equal(version, '090');
});

test('precondition is false when ui.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/ui.json': {} })), true);
});

test('an install without a startPage section gets the editable defaults', async () => {
  const ctx = fakeCtx({ 'config/ui.json': { title: { en: 'iHub Apps' }, header: {}, footer: {} } });

  await up(ctx);
  const ui = ctx.files['config/ui.json'];

  assert.equal(ui.startPage.showDefaultApp, true);
  assert.deepEqual(ui.startPage.subtitle, {
    en: 'How can I help you today?',
    de: 'Wie kann ich Ihnen heute helfen?'
  });
  // Not seeded: an unset defaultAppId means "first app the user can access".
  assert.equal('defaultAppId' in ui.startPage, false);
  // Unrelated sections are left alone.
  assert.deepEqual(ui.title, { en: 'iHub Apps' });
  assert.ok(ctx.logs.some(l => l.includes('start-page')));
});

test("an admin's existing start-page values win over the defaults", async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      title: {},
      header: {},
      footer: {},
      startPage: {
        showDefaultApp: false,
        defaultAppId: 'chat',
        subtitle: { en: 'Ask the assistant' }
      }
    }
  });

  await up(ctx);
  const { startPage } = ctx.files['config/ui.json'];

  assert.equal(startPage.showDefaultApp, false);
  assert.equal(startPage.defaultAppId, 'chat');
  assert.deepEqual(startPage.subtitle, { en: 'Ask the assistant' });
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx({ 'config/ui.json': { title: {}, header: {}, footer: {} } });
  await up(ctx);
  const once = JSON.stringify(ctx.files['config/ui.json']);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['config/ui.json']), once);
});
