#!/usr/bin/env node

/**
 * Migration V111 specs — the CIMD governance settings.
 *
 * Two things this migration has to get right. `blockedClientHosts` starts
 * empty, because an upgrade must block nobody. `approvalMode` starts at
 * `approval`, which is the change of behaviour the release ships: passing the
 * host allowlist makes a client eligible, not allowed. That default is only
 * safe next to V112, which approves the clients an installation's users are
 * already connected through.
 *
 * As ever, a key an operator already set is left exactly as they set it.
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
} from '../migrations/V111__add_oauth_cimd_governance.js';

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

async function seed(dir, platform) {
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/platform.json'),
    JSON.stringify(platform, null, 2),
    'utf8'
  );
}

describe('V111 — CIMD governance settings', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v111-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '111');
    assert.equal(description, 'Add OAuth CIMD governance settings (blocked hosts, approval mode)');
  });

  it('skips when there is no platform.json', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'nofile-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('blocks nobody and requires approval for new clients', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'fresh-'));
    await seed(dir, { oauth: { cimd: { enabled: true, allowedClientHosts: ['claude.ai'] } } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { oauth } = await ctx.readJson('config/platform.json');
    assert.deepEqual(oauth.cimd.blockedClientHosts, [], 'an upgrade must block nobody');
    assert.equal(oauth.cimd.approvalMode, 'approval');
    assert.deepEqual(oauth.cimd.allowedClientHosts, ['claude.ai'], 'the allowlist is untouched');
  });

  it('creates the cimd block when an older install has none', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'no-cimd-'));
    await seed(dir, { oauth: { enabled: { authz: true } } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { oauth } = await ctx.readJson('config/platform.json');
    assert.equal(oauth.cimd.approvalMode, 'approval');
  });

  it('keeps the choice an operator already made', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'partial-'));
    await seed(dir, {
      oauth: { cimd: { approvalMode: 'auto', blockedClientHosts: ['evil.example'] } }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { oauth } = await ctx.readJson('config/platform.json');
    assert.equal(oauth.cimd.approvalMode, 'auto');
    assert.deepEqual(oauth.cimd.blockedClientHosts, ['evil.example']);
  });

  it('skips a platform.json with no oauth section', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'no-oauth-'));
    await seed(dir, { features: {} });
    const ctx = makeCtx(dir);
    await up(ctx);

    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.oauth, undefined);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
  });

  it('is idempotent', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'twice-'));
    await seed(dir, { oauth: {} });
    const ctx = makeCtx(dir);
    await up(ctx);
    const first = await ctx.readJson('config/platform.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/platform.json'), first);
  });
});
