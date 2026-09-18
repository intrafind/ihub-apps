#!/usr/bin/env node

/**
 * Migration V114 specs — removing the no-op proxy block V110 seeded.
 *
 * The point of the migration is that it only removes a block that means
 * nothing. Everything an operator could have decided has to survive it: an
 * explicit `enabled: false` (the only way to refuse a proxy set through
 * HTTP_PROXY in the environment), a configured URL, a bypass entry in either
 * accepted shape, a URL pattern, and any key this migration has never heard of.
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
  description,
  isSeededNoOpProxyBlock
} from '../migrations/V114__drop_seeded_proxy_defaults.js';

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

/** Exactly what V110 writes into a platform.json that had no proxy block. */
const V110_SEED = { enabled: true, http: '', https: '', noProxy: '', urlPatterns: [] };

describe('V114 — drop the seeded proxy defaults', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v114-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '114');
    assert.equal(description, 'Remove the no-op proxy block seeded by V110');
  });

  it('skips when there is no platform.json', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'nofile-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('removes the block V110 seeded, so a fresh install has no proxy config', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'seeded-'));
    await seed(dir, { auth: { mode: 'local' }, proxy: { ...V110_SEED } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const platform = await ctx.readJson('config/platform.json');
    assert.equal('proxy' in platform, false, 'the seeded block is gone');
    assert.deepEqual(platform.auth, { mode: 'local' }, 'the rest of the file is untouched');
  });

  it('removes an empty block whatever shape the blank fields take', async () => {
    const variants = [
      {},
      { enabled: true },
      { http: '', https: '  ' },
      { noProxy: [] },
      { noProxy: ['', '  '] },
      { urlPatterns: [] },
      { enabled: true, http: '', https: '', noProxy: [], urlPatterns: [] }
    ];
    for (const proxy of variants) {
      const dir = await fs.mkdtemp(path.join(baseDir, 'blank-'));
      await seed(dir, { proxy });
      const ctx = makeCtx(dir);
      await up(ctx);
      const platform = await ctx.readJson('config/platform.json');
      assert.equal(
        'proxy' in platform,
        false,
        `expected ${JSON.stringify(proxy)} to be removed as a no-op`
      );
    }
  });

  it('keeps an explicit enabled:false — it is the only way to refuse HTTP_PROXY', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'disabled-'));
    await seed(dir, { proxy: { ...V110_SEED, enabled: false } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.proxy.enabled, false);
  });

  it('keeps a block an operator configured', async () => {
    const configured = [
      { ...V110_SEED, https: 'http://proxy.example.com:8080' },
      { ...V110_SEED, http: 'http://proxy.example.com:8080' },
      { ...V110_SEED, https: '${HTTPS_PROXY}' },
      { ...V110_SEED, noProxy: 'localhost,.local' },
      { ...V110_SEED, noProxy: ['localhost'] },
      { ...V110_SEED, urlPatterns: ['api\\.openai\\.com'] }
    ];
    for (const proxy of configured) {
      const dir = await fs.mkdtemp(path.join(baseDir, 'configured-'));
      await seed(dir, { proxy });
      const ctx = makeCtx(dir);
      await up(ctx);
      const platform = await ctx.readJson('config/platform.json');
      assert.deepEqual(
        platform.proxy,
        proxy,
        `expected ${JSON.stringify(proxy)} to survive untouched`
      );
    }
  });

  it('keeps a block carrying a key it does not know about', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'unknown-key-'));
    const proxy = { ...V110_SEED, futureSetting: 'something' };
    await seed(dir, { proxy });
    const ctx = makeCtx(dir);
    await up(ctx);

    assert.deepEqual((await ctx.readJson('config/platform.json')).proxy, proxy);
  });

  it('leaves a platform.json that never had a proxy block alone', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'no-proxy-'));
    await seed(dir, { auth: { mode: 'local' } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const platform = await ctx.readJson('config/platform.json');
    assert.deepEqual(platform, { auth: { mode: 'local' } });
    assert.ok(ctx.logs.some(([, message]) => /nothing to remove/.test(message)));
  });

  it('is idempotent', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'twice-'));
    await seed(dir, { proxy: { ...V110_SEED } });
    const ctx = makeCtx(dir);
    await up(ctx);
    const first = await ctx.readJson('config/platform.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/platform.json'), first);
  });

  it('never mistakes a non-object for a seeded block', () => {
    for (const value of [null, undefined, 'proxy', 42, [], [{ enabled: true }]]) {
      assert.equal(isSeededNoOpProxyBlock(value), false, `${JSON.stringify(value)} is not a block`);
    }
  });
});
