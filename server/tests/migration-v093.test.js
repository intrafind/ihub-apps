#!/usr/bin/env node

/**
 * Migration V093 specs — seeding `startPage.showUserName` in ui.json.
 *
 * The start-page heading is now configurable: admins can drop the user's name
 * from it, or replace the heading with their own text. The migration writes
 * the behaviour installs already have (`showUserName: true`), so upgrading
 * changes nothing on screen, and deliberately leaves `title` unset — an unset
 * heading uses the bundled greeting translations for every UI language.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V093__add_start_page_heading_config.js';
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
  assert.equal(version, '093');
});

test('precondition is false when ui.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/ui.json': {} })), true);
});

test('an install without the setting keeps greeting users by name', async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      title: { en: 'iHub Apps' },
      startPage: {
        defaultPage: 'start',
        showDefaultApp: true,
        subtitle: { en: 'How can I help you today?' }
      }
    }
  });

  await up(ctx);
  const { startPage } = ctx.files['config/ui.json'];

  assert.equal(startPage.showUserName, true);
  // A custom heading falls back to the bundled translations while unset.
  assert.equal('title' in startPage, false);
  // Everything the earlier start-page migrations seeded survives untouched.
  assert.equal(startPage.defaultPage, 'start');
  assert.equal(startPage.showDefaultApp, true);
  assert.deepEqual(startPage.subtitle, { en: 'How can I help you today?' });
  assert.deepEqual(ctx.files['config/ui.json'].title, { en: 'iHub Apps' });
  assert.ok(ctx.logs.some(l => l.includes('startPage.showUserName')));
});

test('the section is created when ui.json has none', async () => {
  const ctx = fakeCtx({ 'config/ui.json': { title: {}, header: {} } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/ui.json'].startPage, { showUserName: true });
});

test("an admin's existing choice wins over the default", async () => {
  const ctx = fakeCtx({
    'config/ui.json': {
      startPage: { showUserName: false, title: { en: 'Welcome to the AI Hub' } }
    }
  });

  await up(ctx);
  const { startPage } = ctx.files['config/ui.json'];

  assert.equal(startPage.showUserName, false);
  assert.deepEqual(startPage.title, { en: 'Welcome to the AI Hub' });
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx({ 'config/ui.json': { title: {}, startPage: {} } });
  await up(ctx);
  const once = JSON.stringify(ctx.files['config/ui.json']);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['config/ui.json']), once);
});
