#!/usr/bin/env node

/**
 * Migration V120 specs — seeding `officeIntegration.defaultMailAction` in
 * platform.json.
 *
 * The task pane's answer buttons became five distinct actions, and which one
 * the main button runs is now configurable. The migration writes the field so
 * admins find it beside the other add-in settings, seeded with the value that
 * reproduces the pane's own behaviour — without touching a choice an admin
 * already made, and leaving installs that never had an `officeIntegration`
 * block alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V120__office_default_mail_action.js';
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

const platformWithOffice = (defaultMailAction = undefined) => ({
  'config/platform.json': {
    features: { integrations: true },
    officeIntegration: {
      enabled: true,
      oauthClientId: 'office-client',
      displayName: { en: 'iHub Apps' },
      startPage: { defaultPage: 'start', featuredAppIds: [] },
      ...(defaultMailAction ? { defaultMailAction } : {})
    }
  }
});

test('version is the next unused number', () => {
  assert.equal(version, '120');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('an install with the add-in configured gets the automatic default', async () => {
  const ctx = fakeCtx(platformWithOffice());

  await up(ctx);
  const { officeIntegration } = ctx.files['config/platform.json'];

  assert.equal(officeIntegration.defaultMailAction, 'auto');
  // The rest of the block is left alone.
  assert.equal(officeIntegration.enabled, true);
  assert.equal(officeIntegration.oauthClientId, 'office-client');
  assert.deepEqual(officeIntegration.startPage, { defaultPage: 'start', featuredAppIds: [] });
  assert.ok(ctx.logs.some(l => l.includes('defaultMailAction=auto')));
});

test("an admin's existing choice wins over the default", async () => {
  const ctx = fakeCtx(platformWithOffice('forward'));

  await up(ctx);

  assert.equal(
    ctx.files['config/platform.json'].officeIntegration.defaultMailAction,
    'forward',
    'the configured action must survive the migration'
  );
  assert.ok(ctx.logs.some(l => l.includes('nothing to do')));
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
