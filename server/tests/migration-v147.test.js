#!/usr/bin/env node

/**
 * Migration V147 specs — where proxy identity headers may come from.
 *
 * Every installation trusts the local host, whether proxy auth is on yet or
 * not, so a proxy in the same pod works once it is. A list an admin already
 * set is kept.
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
} from '../migrations/V147__add_proxy_auth_trusted_sources.js';
import { setDefault } from '../migrations/utils.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function freshDir(files) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  for (const [rel, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(data), 'utf8');
  }
  return dir;
}

const readPlatform = async dir =>
  JSON.parse(await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v147-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V147 add_proxy_auth_trusted_sources', () => {
  it('declares its version and description', () => {
    assert.equal(version, '147');
    assert.equal(description, 'add_proxy_auth_trusted_sources');
  });

  it('runs only when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'config/platform.json': {} });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('trusts the local host where proxy auth is on', async () => {
    const dir = await freshDir({
      'config/platform.json': { proxyAuth: { enabled: true, userHeader: 'X-Forwarded-User' } }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readPlatform(dir)).proxyAuth, {
      enabled: true,
      userHeader: 'X-Forwarded-User',
      trustedProxies: ['loopback'],
      sharedSecretHeader: 'X-Proxy-Secret'
    });
  });

  it('trusts the local host where proxy auth is off or not configured', async () => {
    for (const platform of [{ proxyAuth: { enabled: false } }, { defaultLanguage: 'en' }]) {
      const dir = await freshDir({ 'config/platform.json': platform });
      await up(makeCtx(dir));
      assert.deepEqual((await readPlatform(dir)).proxyAuth.trustedProxies, ['loopback']);
      assert.equal((await readPlatform(dir)).proxyAuth.sharedSecretHeader, 'X-Proxy-Secret');
    }
  });

  it('keeps a list and header an admin already set, including an empty list', async () => {
    for (const trustedProxies of [['10.0.0.5'], []]) {
      const dir = await freshDir({
        'config/platform.json': {
          proxyAuth: { enabled: true, trustedProxies, sharedSecretHeader: 'X-Gate' }
        }
      });
      await up(makeCtx(dir));
      assert.deepEqual((await readPlatform(dir)).proxyAuth, {
        enabled: true,
        trustedProxies,
        sharedSecretHeader: 'X-Gate'
      });
    }
  });
});
