#!/usr/bin/env node

/**
 * Migration V145 specs — short links get a host allowlist.
 *
 * `platform.shortLinks.allowedHosts` lists the hosts an absolute short link
 * target may name. It starts empty (paths on this server only) and an
 * existing list is never touched.
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
} from '../migrations/V145__add_short_link_allowed_hosts.js';
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
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v145-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V145 add_short_link_allowed_hosts', () => {
  it('declares its version and description', () => {
    assert.equal(version, '145');
    assert.equal(description, 'add_short_link_allowed_hosts');
  });

  it('runs only when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'config/platform.json': {} });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('adds an empty allowlist', async () => {
    const dir = await freshDir({ 'config/platform.json': { defaultLanguage: 'en' } });
    await up(makeCtx(dir));
    assert.deepEqual(await readPlatform(dir), {
      defaultLanguage: 'en',
      shortLinks: { allowedHosts: [] }
    });
  });

  it('keeps hosts an admin already listed', async () => {
    const dir = await freshDir({
      'config/platform.json': { shortLinks: { allowedHosts: ['docs.example.com'] } }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readPlatform(dir)).shortLinks, { allowedHosts: ['docs.example.com'] });
  });
});
