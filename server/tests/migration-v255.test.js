#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V255 specs — admin API limit raised from the old shipped 100 per
 * minute to the shipped default.
 *
 * Only the untouched old values (100 per 60000 ms) are raised, to the value of
 * server/defaults/config/platform.json. A limit or window an admin set, and an
 * install without an `adminApi` section, stay as they are. V255 runs after
 * V254 (limits_for_large_installations) and never changes what V254 set.
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
  description
} from '../migrations/V255__admin_api_rate_limit_default.js';
import { up as upV254 } from '../migrations/V254__limits_for_large_installations.js';
import { setDefault } from '../migrations/utils.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');
const shipped = JSON.parse(
  await fs.readFile(path.join(defaultsDir, 'config', 'platform.json'), 'utf8')
);
const SHIPPED_LIMIT = shipped.rateLimit.adminApi.limit;

let baseDir;

function makeCtx(dir, logs) {
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
    log: message => logs.push(message),
    warn: message => logs.push(message)
  };
}

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v255-'));
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

describe('V255 admin_api_rate_limit_default', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v255-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 255', () => {
    assert.equal(version, '255');
    assert.equal(description, 'admin_api_rate_limit_default');
  });

  it('skips an install without a platform config', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('raises the old shipped 100 per minute to the shipped default and keeps the other fields', async () => {
    const { ctx, read } = await seed({
      rateLimit: {
        default: { windowMs: 60000, limit: 100 },
        adminApi: { windowMs: 60000, limit: 100, keyBy: 'user', skipFailedRequests: true },
        publicApi: { windowMs: 60000, limit: 500 }
      }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const { rateLimit } = await read();
    assert.deepEqual(rateLimit.adminApi, {
      windowMs: 60000,
      limit: SHIPPED_LIMIT,
      keyBy: 'user',
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
    assert.equal((await read()).rateLimit.adminApi.limit, SHIPPED_LIMIT);
    assert.ok(logs.some(line => /nothing to do/.test(line)));
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

  describe('after V254', () => {
    it('leaves what V254 set on an untouched install', async () => {
      const { ctx, raw } = await seed({
        rateLimit: { adminApi: { windowMs: 60000, limit: 100, skipFailedRequests: true } }
      });
      await upV254(ctx);
      const afterV254 = await raw();
      await up(ctx);
      assert.equal(await raw(), afterV254);
      assert.equal(JSON.parse(afterV254).rateLimit.adminApi.limit, SHIPPED_LIMIT);
    });

    it("keeps an admin's own limit that V254 kept", async () => {
      const { ctx, read } = await seed({
        rateLimit: { adminApi: { windowMs: 120000, limit: 100 } }
      });
      await upV254(ctx);
      const afterV254 = await read();
      await up(ctx);
      assert.deepEqual(await read(), afterV254);
      assert.equal(afterV254.rateLimit.adminApi.limit, 100);
    });

    it('raises the old 100 that V254 leaves because keyBy was already set', async () => {
      const { ctx, read } = await seed({
        rateLimit: { adminApi: { windowMs: 60000, limit: 100, keyBy: 'user' } }
      });
      await upV254(ctx);
      assert.equal((await read()).rateLimit.adminApi.limit, 100);
      await up(ctx);
      assert.equal((await read()).rateLimit.adminApi.limit, SHIPPED_LIMIT);
    });
  });
});
