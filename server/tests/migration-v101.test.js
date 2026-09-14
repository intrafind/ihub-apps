#!/usr/bin/env node

/**
 * Migration V101 specs — CIMD arrives off, and with a host allowlist.
 *
 * A Client ID Metadata Document client identifies itself with a URL supplied
 * by whoever opened the authorization request, so the two things this
 * migration must get right are that an upgrade behaves exactly as before
 * (`enabled: false`) and that switching it on later trusts `claude.ai` rather
 * than every HTTPS host on the internet.
 *
 * Keys an operator already set are preserved individually, so someone who
 * pre-seeded only `enabled` does not have the rest of the block withheld —
 * nor their choice overwritten.
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
} from '../migrations/V101__add_oauth_cimd_defaults.js';

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

describe('V101 — OAuth CIMD defaults', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v101-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '101');
    assert.equal(description, 'Add OAuth Client ID Metadata Document (CIMD) defaults');
  });

  it('skips when there is no platform.json', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'nofile-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('adds the block switched off and trusting claude.ai only', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'fresh-'));
    await seed(dir, { oauth: { enabled: { authz: true }, dcr: { enabled: true } } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { oauth } = await ctx.readJson('config/platform.json');
    assert.equal(oauth.cimd.enabled, false, 'an upgrade must behave exactly as before');
    assert.deepEqual(oauth.cimd.allowedClientHosts, ['claude.ai']);
    assert.deepEqual(oauth.cimd.allowedScopes, []);
    assert.equal(oauth.cimd.cacheMaxSeconds, 86400);
    assert.equal(oauth.cimd.fetchTimeoutMs, 5000);
    assert.equal(oauth.dcr.enabled, true, 'the dcr block is untouched');
  });

  it('never writes tokenExpirationMinutes, so it keeps tracking the platform default', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'token-exp-'));
    await seed(dir, { oauth: { defaultTokenExpirationMinutes: 60 } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { oauth } = await ctx.readJson('config/platform.json');
    assert.equal(oauth.cimd.tokenExpirationMinutes, undefined);
  });

  it('preserves the keys an operator already set and fills in only the rest', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'partial-'));
    await seed(dir, {
      oauth: { cimd: { enabled: true, allowedClientHosts: ['claude.ai', 'cursor.com'] } }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { oauth } = await ctx.readJson('config/platform.json');
    assert.equal(oauth.cimd.enabled, true);
    assert.deepEqual(oauth.cimd.allowedClientHosts, ['claude.ai', 'cursor.com']);
    assert.equal(oauth.cimd.cacheMaxSeconds, 86400);
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
    const second = await ctx.readJson('config/platform.json');
    assert.deepEqual(second, first);
  });
});
