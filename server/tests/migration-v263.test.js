#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V263 specs — seeding `platform.userApps.capabilities.webSearchLimits`
 * and `platform.userApps.capabilities.projects`.
 *
 * The defaults land where they are missing and where `platform.userApps` exists;
 * a value an admin set stays, a second run changes nothing, and an installation
 * without the block is left alone (the settings reader fills the defaults).
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
  DEFAULT_MAX_PAGE_READS
} from '../migrations/V263__user_apps_advanced_capabilities.js';
import { setDefault } from '../migrations/utils.js';
import {
  DEFAULT_USER_APP_SETTINGS,
  userAppSettings
} from '../services/userApps/userAppSettings.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes.push(rel);
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v263-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  return { dir, ctx: makeCtx(dir) };
}

const readPlatform = async dir =>
  JSON.parse(await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v263-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V263 user_apps_advanced_capabilities', () => {
  it('has its version and description, and the default of the settings reader', () => {
    assert.equal(version, '263');
    assert.equal(description, 'user_apps_advanced_capabilities');
    assert.equal(
      DEFAULT_MAX_PAGE_READS,
      DEFAULT_USER_APP_SETTINGS.capabilities.webSearchLimits.maxPageReads
    );
    assert.equal(DEFAULT_USER_APP_SETTINGS.capabilities.projects, false);
  });

  it('runs only where platform.json exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
    const { ctx: withFile } = await seed({});
    assert.equal(await precondition(withFile), true);
  });

  it('seeds the limit next to what the block already holds', async () => {
    const { dir, ctx } = await seed({
      userApps: { capabilities: { webSearch: true, modelChoice: false } }
    });
    await up(ctx);
    const platform = await readPlatform(dir);
    assert.deepEqual(platform.userApps.capabilities, {
      webSearch: true,
      modelChoice: false,
      webSearchLimits: { maxPageReads: DEFAULT_MAX_PAGE_READS },
      projects: false
    });
    assert.deepEqual(ctx.writes, ['config/platform.json']);
  });

  it('keeps what an administrator set, and a second run changes nothing', async () => {
    const { dir, ctx } = await seed({
      userApps: { capabilities: { webSearchLimits: { maxPageReads: 3 }, projects: true } }
    });
    await up(ctx);
    const kept = (await readPlatform(dir)).userApps.capabilities;
    assert.equal(kept.webSearchLimits.maxPageReads, 3);
    assert.equal(kept.projects, true);
    assert.deepEqual(ctx.writes, []);

    const { dir: again, ctx: second } = await seed({ userApps: {} });
    await up(second);
    const first = await readPlatform(again);
    await up(second);
    assert.deepEqual(await readPlatform(again), first);
    assert.equal(second.writes.length, 1);
  });

  it('leaves an installation without platform.userApps alone', async () => {
    const { dir, ctx } = await seed({ defaultLanguage: 'en' });
    await up(ctx);
    assert.deepEqual(await readPlatform(dir), { defaultLanguage: 'en' });
    assert.deepEqual(ctx.writes, []);
    // The settings reader gives the same limit without the key.
    assert.equal(userAppSettings({}).capabilities.webSearchLimits.maxPageReads, 10);
  });
});
