#!/usr/bin/env node

/**
 * Migration V159 specs — OAuth rate limits sized for real traffic.
 *
 * The migration raises `rateLimit.oauthApi` only where it still carries the
 * shipped 50 per 15 minutes, keeps an admin's own values, and adds the new
 * `rateLimit.oauthTokenApi` (failed requests only). The defaults and the
 * runtime fallbacks agree with it, so fresh and upgraded installs match.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description,
  OAUTH_API_DEFAULTS,
  OAUTH_TOKEN_API_DEFAULTS
} from '../migrations/V159__realistic_oauth_rate_limits.js';
import { setDefault } from '../migrations/utils.js';
import { resolveRateLimitConfigs } from '../middleware/rateLimiting.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');

let baseDir;

function makeCtx(dir) {
  return {
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: () => {},
    warn: () => {}
  };
}

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v159-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  const ctx = makeCtx(dir);
  return { ctx, read: () => ctx.readJson('config/platform.json') };
}

describe('V159 realistic_oauth_rate_limits', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v159-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 159', () => {
    assert.equal(version, '159');
    assert.equal(description, 'realistic_oauth_rate_limits');
  });

  it('skips an install without a platform config', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('raises the shipped OAuth limit and adds the token limit', async () => {
    const { ctx, read } = await seed({
      rateLimit: {
        authApi: { windowMs: 900000, limit: 30 },
        oauthApi: { windowMs: 900000, limit: 50, skipFailedRequests: false }
      }
    });
    await up(ctx);
    const { rateLimit } = await read();
    assert.deepEqual(rateLimit.oauthApi, {
      windowMs: 60000,
      limit: 300,
      skipFailedRequests: false
    });
    assert.deepEqual(rateLimit.oauthTokenApi, OAUTH_TOKEN_API_DEFAULTS);
    // Other limiters are not touched.
    assert.deepEqual(rateLimit.authApi, { windowMs: 900000, limit: 30 });
  });

  it("keeps an admin's own OAuth limits", async () => {
    const { ctx, read } = await seed({
      rateLimit: {
        oauthApi: { windowMs: 900000, limit: 1000 },
        oauthTokenApi: { limit: 5 }
      }
    });
    await up(ctx);
    const { rateLimit } = await read();
    assert.deepEqual(rateLimit.oauthApi, { windowMs: 900000, limit: 1000 });
    assert.equal(rateLimit.oauthTokenApi.limit, 5);
    assert.equal(rateLimit.oauthTokenApi.skipSuccessfulRequests, true);
  });

  it('adds both sections where there is no rate limit config at all', async () => {
    const { ctx, read } = await seed({ defaultLanguage: 'en' });
    await up(ctx);
    const platform = await read();
    assert.deepEqual(platform.rateLimit.oauthApi, { ...OAUTH_API_DEFAULTS });
    assert.deepEqual(platform.rateLimit.oauthTokenApi, OAUTH_TOKEN_API_DEFAULTS);
    assert.equal(platform.defaultLanguage, 'en');
  });

  it('agrees with the shipped defaults and with the runtime fallbacks', async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'config', 'platform.json'), 'utf8')
    );
    assert.equal(defaults.rateLimit.oauthApi.windowMs, OAUTH_API_DEFAULTS.windowMs);
    assert.equal(defaults.rateLimit.oauthApi.limit, OAUTH_API_DEFAULTS.limit);
    assert.deepEqual(defaults.rateLimit.oauthTokenApi, OAUTH_TOKEN_API_DEFAULTS);

    const runtime = resolveRateLimitConfigs({});
    assert.equal(runtime.oauthApi.windowMs, OAUTH_API_DEFAULTS.windowMs);
    assert.equal(runtime.oauthApi.limit, OAUTH_API_DEFAULTS.limit);
    for (const [key, value] of Object.entries(OAUTH_TOKEN_API_DEFAULTS)) {
      assert.equal(runtime.oauthTokenApi[key], value, key);
    }
  });
});
