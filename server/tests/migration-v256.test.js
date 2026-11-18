// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V256: the shipped per-address sign-in ceiling (5,000) becomes the
 * new shipped value; an admin's own value stays.
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
  version
} from '../migrations/V256__failed_sign_in_ceiling_per_address.js';

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
    writeJson: async (rel, data) =>
      fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8'),
    log: () => {}
  };
}

async function migrate(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v256-'));
  await fs.mkdir(path.join(dir, 'config'));
  await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  const ctx = makeCtx(dir);
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  return ctx.readJson('config/platform.json');
}

describe('V256 failed sign-in ceiling per address', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v256-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 256 and ships a lower ceiling', () => {
    assert.equal(version, '256');
    assert.ok(shipped.rateLimit.authApi.perIpLimit < 5000);
  });

  it('lowers the shipped 5000', async () => {
    const platform = await migrate({ rateLimit: { authApi: { limit: 30, perIpLimit: 5000 } } });
    assert.equal(platform.rateLimit.authApi.perIpLimit, shipped.rateLimit.authApi.perIpLimit);
    assert.equal(platform.rateLimit.authApi.limit, 30);
  });

  it("keeps an admin's own value", async () => {
    const platform = await migrate({ rateLimit: { authApi: { limit: 30, perIpLimit: 4000 } } });
    assert.equal(platform.rateLimit.authApi.perIpLimit, 4000);
  });

  it('leaves a config without authApi alone', async () => {
    const platform = await migrate({ rateLimit: {} });
    assert.deepEqual(platform, { rateLimit: {} });
  });
});
