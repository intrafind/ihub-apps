#!/usr/bin/env node

/**
 * Migration V099 specs — do not sweep workflow history an admin never chose to sweep.
 *
 * V098 seeded `workflowState.cleanupEnabled: true` on every installation,
 * including ones that already held a year of workflow checkpoints. Those keys
 * never existed before, so there was no operator choice for `setDefault` to
 * preserve — the sweep simply arrived switched on, and its first tick removes
 * every terminal execution older than thirty days. This migration turns it
 * back off, but only where there is pre-existing state to protect.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description
} from '../migrations/V099__workflow_retention_opt_in_for_upgrades.js';

let baseDir;

/** A migration context over a scratch contents directory. */
function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel =>
      fs
        .readFile(path.join(dir, rel), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed(dir, platform, { withState = false } = {}) {
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/platform.json'),
    JSON.stringify(platform, null, 2),
    'utf8'
  );
  if (withState) {
    await fs.mkdir(path.join(dir, 'data/workflow-state/wf-exec-1'), { recursive: true });
  }
}

describe('V099 — workflow retention opt-in for upgrades', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v099-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '099');
    assert.equal(description, 'workflow_retention_opt_in_for_upgrades');
  });

  it('skips when there is no platform.json', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'nofile-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('turns the sweep off when workflow state already exists', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'upgrade-'));
    await seed(
      dir,
      { workflowState: { retentionDays: 30, cleanupEnabled: true } },
      {
        withState: true
      }
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.workflowState.cleanupEnabled, false);
    assert.equal(platform.workflowState.retentionDays, 30, 'the window itself is untouched');
  });

  it('leaves a fresh installation opted in', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'fresh-'));
    await seed(dir, { workflowState: { retentionDays: 30, cleanupEnabled: true } });
    const ctx = makeCtx(dir);
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.workflowState.cleanupEnabled, true);
  });

  it('does not touch a value the admin already set to false', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'already-off-'));
    await seed(
      dir,
      { workflowState: { retentionDays: 7, cleanupEnabled: false } },
      {
        withState: true
      }
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.workflowState.cleanupEnabled, false);
    assert.equal(platform.workflowState.retentionDays, 7);
  });

  it('is idempotent', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'twice-'));
    await seed(
      dir,
      { workflowState: { retentionDays: 30, cleanupEnabled: true } },
      {
        withState: true
      }
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.workflowState.cleanupEnabled, false);
  });
});
