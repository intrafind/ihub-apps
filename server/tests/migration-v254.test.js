#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V254 specs — admin API limit raised from 100 to 500 per minute.
 *
 * Only the untouched shipped values (100 per 60000 ms) are raised. A limit or
 * window an admin set, and an install without an `adminApi` section, stay as
 * they are. The shipped defaults and the runtime fallback agree with it.
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
  ADMIN_API_LIMIT
} from '../migrations/V254__admin_api_rate_limit_default.js';
import { resolveRateLimitConfigs } from '../middleware/rateLimiting.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');

let baseDir;

function makeCtx(dir, logs) {
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
    log: message => logs.push(message),
    warn: message => logs.push(message)
  };
}

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v254-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  const file = path.join(dir, 'config/platform.json');
  if (platform !== null) {
    await fs.writeFile(file, JSON.stringify(platform), 'utf8');
  }
  const logs = [];
  const ctx = makeCtx(dir, logs);
  return {
    ctx,
    logs,
    read: () => ctx.readJson('config/platform.json'),
    raw: () => fs.readFile(file, 'utf8')
  };
}

describe('V254 admin_api_rate_limit_default', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v254-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 254', () => {
    assert.equal(version, '254');
    assert.equal(description, 'admin_api_rate_limit_default');
  });

  it('skips an install without a platform config', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('raises the shipped 100 per minute to 500 and keeps the other fields', async () => {
    const { ctx, read } = await seed({
      rateLimit: {
        default: { windowMs: 60000, limit: 100 },
        adminApi: { windowMs: 60000, limit: 100, skipFailedRequests: true },
        publicApi: { windowMs: 60000, limit: 500 }
      }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const { rateLimit } = await read();
    assert.deepEqual(rateLimit.adminApi, {
      windowMs: 60000,
      limit: 500,
      skipFailedRequests: true
    });
    // Other limiters, the default section included, are not touched.
    assert.deepEqual(rateLimit.default, { windowMs: 60000, limit: 100 });
    assert.deepEqual(rateLimit.publicApi, { windowMs: 60000, limit: 500 });
  });

  it('keeps a tuned limit and logs it', async () => {
    const platform = { rateLimit: { adminApi: { windowMs: 60000, limit: 250 } } };
    const { ctx, read, logs } = await seed(platform);
    await up(ctx);
    assert.deepEqual(await read(), platform);
    assert.ok(logs.some(line => /customized/.test(line) && /250/.test(line)));
  });

  it('says "nothing to do", not "customized", when it runs again on its own result', async () => {
    const { ctx, read, raw, logs } = await seed({
      rateLimit: { adminApi: { windowMs: 60000, limit: 100 } }
    });
    await up(ctx);
    const afterFirst = await raw();
    logs.length = 0;

    await up(ctx);
    assert.equal(await raw(), afterFirst);
    assert.equal((await read()).rateLimit.adminApi.limit, 500);
    assert.ok(logs.some(line => /already 500/.test(line) && /nothing to do/.test(line)));
    assert.ok(!logs.some(line => /customi[sz]ed/.test(line)));
  });

  it('keeps 100 requests over a tuned window', async () => {
    const platform = { rateLimit: { adminApi: { windowMs: 300000, limit: 100 } } };
    const { ctx, read } = await seed(platform);
    await up(ctx);
    assert.deepEqual(await read(), platform);
  });

  it('leaves an install without an adminApi section unchanged', async () => {
    for (const platform of [
      { defaultLanguage: 'en' },
      { rateLimit: { default: { limit: 100 } } }
    ]) {
      const { ctx, raw } = await seed(platform);
      const before = await raw();
      await up(ctx);
      assert.equal(await raw(), before);
    }
  });

  it('agrees with the shipped defaults and the runtime fallback', async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'config', 'platform.json'), 'utf8')
    );
    assert.equal(defaults.rateLimit.adminApi.limit, ADMIN_API_LIMIT);
    assert.equal(defaults.rateLimit.adminApi.windowMs, 60000);
    assert.equal(resolveRateLimitConfigs({}).adminApi.limit, ADMIN_API_LIMIT);
  });
});
