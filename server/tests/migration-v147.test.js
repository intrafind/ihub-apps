#!/usr/bin/env node

/**
 * Migration V147 specs — where proxy identity headers may come from.
 *
 * Installs with proxy auth on (platform.json or PROXY_AUTH_ENABLED) trust the
 * local host; others start with an empty list. A list an admin already set is
 * kept.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
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
  const ENV_NAMES = ['PROXY_AUTH_ENABLED', 'IHUB_PLATFORM__PROXY_AUTH__ENABLED'];
  const savedEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

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
    for (const name of ENV_NAMES) delete process.env[name];
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

  for (const name of ENV_NAMES) {
    it(`trusts the local host when ${name} turns proxy auth on`, async () => {
      for (const other of ENV_NAMES) delete process.env[other];
      process.env[name] = 'TRUE';
      const dir = await freshDir({ 'config/platform.json': { proxyAuth: { enabled: false } } });
      await up(makeCtx(dir));
      assert.deepEqual((await readPlatform(dir)).proxyAuth.trustedProxies, ['loopback']);
    });
  }

  it('starts with an empty list where proxy auth is off', async () => {
    for (const name of ENV_NAMES) delete process.env[name];
    const dir = await freshDir({ 'config/platform.json': { defaultLanguage: 'en' } });
    await up(makeCtx(dir));
    assert.deepEqual((await readPlatform(dir)).proxyAuth, {
      trustedProxies: [],
      sharedSecretHeader: 'X-Proxy-Secret'
    });
  });

  it('keeps a list and header an admin already set', async () => {
    for (const name of ENV_NAMES) delete process.env[name];
    const dir = await freshDir({
      'config/platform.json': {
        proxyAuth: { enabled: true, trustedProxies: ['10.0.0.5'], sharedSecretHeader: 'X-Gate' }
      }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readPlatform(dir)).proxyAuth, {
      enabled: true,
      trustedProxies: ['10.0.0.5'],
      sharedSecretHeader: 'X-Gate'
    });
  });
});
