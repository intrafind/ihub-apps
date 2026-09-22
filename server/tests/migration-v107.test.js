#!/usr/bin/env node

/**
 * Migration V107 specs — seeding `officeIntegration.startPage` in platform.json.
 *
 * The Outlook task pane gained a start page whose settings live in a new
 * `startPage` block of the `officeIntegration` section. Existing installs have
 * no such block, so the migration seeds editable defaults without touching
 * anything an admin already set — and leaves installs that never had an
 * `officeIntegration` block alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V107__add_office_start_page_config.js';
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

const platformWithOffice = (startPage = undefined) => ({
  'config/platform.json': {
    features: { integrations: true },
    officeIntegration: {
      enabled: true,
      oauthClientId: 'office-client',
      displayName: { en: 'iHub Apps' },
      ...(startPage ? { startPage } : {})
    }
  }
});

test('version is the next unused number', () => {
  assert.equal(version, '107');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('an install with the add-in configured gets the editable defaults', async () => {
  const ctx = fakeCtx(platformWithOffice());

  await up(ctx);
  const { officeIntegration } = ctx.files['config/platform.json'];

  assert.equal(officeIntegration.startPage.defaultPage, 'start');
  assert.deepEqual(officeIntegration.startPage.featuredAppIds, []);
  // Not seeded: an unset defaultAppId means "the top-ranked app the user can access".
  assert.equal('defaultAppId' in officeIntegration.startPage, false);
  // The rest of the block is left alone.
  assert.equal(officeIntegration.enabled, true);
  assert.equal(officeIntegration.oauthClientId, 'office-client');
  assert.ok(ctx.logs.some(l => l.includes('start-page')));
});

test("an admin's existing start-page values win over the defaults", async () => {
  const ctx = fakeCtx(
    platformWithOffice({
      defaultPage: 'apps',
      defaultAppId: 'email-assistant',
      featuredAppIds: ['email-assistant', 'summarizer']
    })
  );

  await up(ctx);
  const { startPage } = ctx.files['config/platform.json'].officeIntegration;

  assert.deepEqual(startPage, {
    defaultPage: 'apps',
    defaultAppId: 'email-assistant',
    featuredAppIds: ['email-assistant', 'summarizer']
  });
});

test('a half-written block is completed, not replaced', async () => {
  const ctx = fakeCtx(platformWithOffice({ defaultAppId: 'email-assistant' }));

  await up(ctx);
  const { startPage } = ctx.files['config/platform.json'].officeIntegration;

  assert.equal(startPage.defaultAppId, 'email-assistant');
  assert.equal(startPage.defaultPage, 'start');
  assert.deepEqual(startPage.featuredAppIds, []);
});

test('an install without an officeIntegration block is left untouched', async () => {
  const files = { 'config/platform.json': { features: { integrations: false }, auth: {} } };
  const before = JSON.stringify(files['config/platform.json']);
  const ctx = fakeCtx(files);

  await up(ctx);

  assert.equal(JSON.stringify(ctx.files['config/platform.json']), before);
  assert.ok(ctx.logs.some(l => l.includes('nothing to seed')));
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx(platformWithOffice());
  await up(ctx);
  const once = JSON.stringify(ctx.files['config/platform.json']);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['config/platform.json']), once);
  assert.ok(ctx.logs.some(l => l.includes('nothing to do')));
});
