// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V254 specs — limits for large installations.
 *
 * The migration raises a limit only where it still carries the old shipped
 * value, keeps an admin's own values (never making anything stricter), and
 * adds the new fields: `keyBy` / `anonymousLimit` on the general limiters,
 * `authApi.perIpLimit`, and raises `requestConcurrency`. The new values come
 * from server/defaults/config/platform.json.
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
  PREVIOUS_GENERAL_LIMITS
} from '../migrations/V254__limits_for_large_installations.js';
import { setDefault } from '../migrations/utils.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');
const shipped = JSON.parse(
  await fs.readFile(path.join(defaultsDir, 'config', 'platform.json'), 'utf8')
);

let baseDir;

function makeCtx(dir) {
  return {
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    readDefaultJson: async rel =>
      JSON.parse(await fs.readFile(path.join(defaultsDir, rel), 'utf8')),
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
  const dir = await fs.mkdtemp(path.join(baseDir, 'v254-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  const ctx = makeCtx(dir);
  return { ctx, read: () => ctx.readJson('config/platform.json') };
}

/** The rate-limit and concurrency settings as shipped before V254. */
function previousShipped() {
  return {
    requestConcurrency: 5,
    rateLimit: {
      default: { windowMs: 60000, limit: 100, skipFailedRequests: true },
      adminApi: { windowMs: 60000, limit: 100, skipFailedRequests: true },
      publicApi: { windowMs: 60000, limit: 500, skipFailedRequests: true },
      authApi: { windowMs: 900000, limit: 30, skipFailedRequests: false },
      oauthApi: { windowMs: 60000, limit: 300, skipFailedRequests: false },
      inferenceApi: { windowMs: 60000, limit: 500 }
    }
  };
}

describe('V254 limits_for_large_installations', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v254-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 254', () => {
    assert.equal(version, '254');
    assert.equal(description, 'limits_for_large_installations');
  });

  it('skips an install without a platform config', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('brings untouched shipped limits to the new shipped defaults', async () => {
    const { ctx, read } = await seed(previousShipped());
    await up(ctx);
    const platform = await read();
    for (const key of Object.keys(PREVIOUS_GENERAL_LIMITS)) {
      const { limit, keyBy, anonymousLimit } = platform.rateLimit[key];
      assert.equal(limit, shipped.rateLimit[key].limit, key);
      assert.equal(keyBy, shipped.rateLimit[key].keyBy, key);
      assert.equal(anonymousLimit, shipped.rateLimit[key].anonymousLimit, key);
    }
    assert.equal(platform.rateLimit.authApi.limit, 30);
    assert.equal(platform.rateLimit.authApi.perIpLimit, shipped.rateLimit.authApi.perIpLimit);
    assert.equal(platform.requestConcurrency, shipped.requestConcurrency);
    assert.notEqual(shipped.requestConcurrency, 5);
    // Limiters the change is not about stay as they were.
    assert.deepEqual(platform.rateLimit.oauthApi, previousShipped().rateLimit.oauthApi);
  });

  it("keeps an admin's own values and never makes anything stricter", async () => {
    const own = previousShipped();
    own.requestConcurrency = 100;
    own.rateLimit.publicApi = { windowMs: 60000, limit: 1000000 };
    own.rateLimit.adminApi = { windowMs: 120000, limit: 100 };
    own.rateLimit.authApi = { windowMs: 900000, limit: 100000 };
    const { ctx, read } = await seed(own);
    await up(ctx);
    const platform = await read();

    // Own limit stays, now per user; anonymous requests keep it per address.
    assert.deepEqual(platform.rateLimit.publicApi, {
      windowMs: 60000,
      limit: 1000000,
      keyBy: 'user',
      anonymousLimit: 1000000
    });
    // An own window makes the limit an own one too.
    assert.equal(platform.rateLimit.adminApi.limit, 100);
    assert.equal(platform.rateLimit.adminApi.anonymousLimit, 100);
    // The address ceiling is never below an own per-address limit.
    assert.equal(platform.rateLimit.authApi.limit, 100000);
    assert.equal(platform.rateLimit.authApi.perIpLimit, 100000);
    // An own concurrency stays.
    assert.equal(platform.requestConcurrency, 100);
  });

  it('leaves concurrency unlimited where requestConcurrency is unset', async () => {
    const { ctx, read } = await seed({ defaultLanguage: 'en' });
    await up(ctx);
    const platform = await read();
    assert.equal(platform.requestConcurrency, undefined);
    assert.equal(platform.rateLimit, undefined);
  });

  it('does nothing on a second run', async () => {
    const { ctx, read } = await seed(previousShipped());
    await up(ctx);
    const once = await read();
    await up(ctx);
    assert.deepEqual(await read(), once);
  });
});
