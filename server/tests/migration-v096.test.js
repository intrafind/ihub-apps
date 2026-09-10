#!/usr/bin/env node

/**
 * Migration V096 specs — seeding the `workflowState` section in platform.json.
 *
 * The seeded values are the built-in defaults of the new retention sweep, so
 * the upgrade itself changes nothing an admin has decided: it makes the
 * section visible in Admin → Platform Configuration. The interesting cases
 * are the meaningful zero (`retentionDays: 0` means "keep terminal
 * executions forever" and must survive) and an explicit `cleanupEnabled:
 * false`, which is how an installation opts out of the sweep entirely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V096__add_workflow_state_retention.js';
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
  assert.equal(version, '096');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('a plain install gets the workflow state retention defaults', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });

  await up(ctx);

  assert.deepEqual(ctx.files['config/platform.json'].workflowState, {
    retentionDays: 30,
    cleanupEnabled: true
  });
  assert.ok(ctx.logs.some(l => l.includes('workflowState')));
});

test("an admin's existing retention window wins over the default", async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      workflowState: { retentionDays: 0 }
    }
  });

  await up(ctx);
  const { workflowState } = ctx.files['config/platform.json'];

  // retentionDays 0 means "keep terminal executions forever" — a meaningful
  // value, not a missing one, so the default must not overwrite it.
  assert.equal(workflowState.retentionDays, 0);
  assert.equal(workflowState.cleanupEnabled, true);
});

test('an install that switched the sweep off stays off', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      workflowState: { cleanupEnabled: false }
    }
  });

  await up(ctx);
  const { workflowState } = ctx.files['config/platform.json'];

  assert.equal(workflowState.cleanupEnabled, false);
  assert.equal(workflowState.retentionDays, 30);
});

test('running the migration twice is a no-op', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { workflowState: {} } });
  await up(ctx);
  const once = JSON.stringify(ctx.files['config/platform.json']);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['config/platform.json']), once);
});

test('unrelated platform sections survive untouched', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      defaultLanguage: 'de',
      auth: { mode: 'oidc', authenticatedGroup: 'authenticated' },
      runLog: { enabled: true, retentionDays: 90, cleanupEnabled: true },
      chats: { enabled: true, retentionDays: 90, maxChatsPerUser: 200 },
      storage: { provider: 'filesystem', filesystem: { dataDir: 'data' } }
    }
  });

  await up(ctx);
  const platform = ctx.files['config/platform.json'];

  assert.equal(platform.defaultLanguage, 'de');
  assert.deepEqual(platform.auth, { mode: 'oidc', authenticatedGroup: 'authenticated' });
  assert.deepEqual(platform.runLog, { enabled: true, retentionDays: 90, cleanupEnabled: true });
  assert.deepEqual(platform.chats, { enabled: true, retentionDays: 90, maxChatsPerUser: 200 });
  assert.deepEqual(platform.storage, { provider: 'filesystem', filesystem: { dataDir: 'data' } });
});
