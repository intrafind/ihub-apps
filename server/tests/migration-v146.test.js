#!/usr/bin/env node

/**
 * Migration V146 specs — local sign-in lockout settings.
 *
 * `platform.localAuth.lockout` gets its defaults (on, 5 attempts, 15 minutes);
 * values an admin already set are kept.
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
} from '../migrations/V146__add_local_auth_lockout.js';
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
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v146-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V146 add_local_auth_lockout', () => {
  it('declares its version and description', () => {
    assert.equal(version, '146');
    assert.equal(description, 'add_local_auth_lockout');
  });

  it('runs only when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'config/platform.json': {} });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('adds the lockout defaults next to the existing local auth settings', async () => {
    const dir = await freshDir({
      'config/platform.json': { localAuth: { enabled: true, showDemoAccounts: true } }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readPlatform(dir)).localAuth, {
      enabled: true,
      showDemoAccounts: true,
      lockout: { enabled: true, maxAttempts: 5, durationMinutes: 15 }
    });
  });

  it('keeps values an admin already set', async () => {
    const dir = await freshDir({
      'config/platform.json': { localAuth: { lockout: { enabled: false, maxAttempts: 10 } } }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readPlatform(dir)).localAuth.lockout, {
      enabled: false,
      maxAttempts: 10,
      durationMinutes: 15
    });
  });
});
