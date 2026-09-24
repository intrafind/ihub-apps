#!/usr/bin/env node

/**
 * Migration V128 specs — seeding `platform.chats.sharing`.
 *
 * The migration adds the built-in defaults where they are missing and leaves
 * every value an admin already set exactly as it is; it never writes
 * `features.json`, because turning sharing on is the admin's call.
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
  SHARING_DEFAULTS
} from '../migrations/V128__chat_sharing_defaults.js';
import { setDefault } from '../migrations/utils.js';

let baseDir;

/** A migration context over a scratch contents directory. */
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
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a scratch contents dir holding this platform config. */
async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v128-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(
      path.join(dir, 'config/platform.json'),
      JSON.stringify(platform, null, 2),
      'utf8'
    );
  }
  return { dir, ctx: makeCtx(dir) };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v128-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V128 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '128');
    assert.equal(description, 'chat_sharing_defaults');
  });

  it('only runs when platform.json exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
    const { ctx: withPlatform } = await seed({});
    assert.equal(await precondition(withPlatform), true);
  });
});

describe('V128 seeds the sharing block', () => {
  it('adds every default to an installation that has none', async () => {
    const { ctx } = await seed({ chats: { enabled: true, retentionDays: 90 } });
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.deepEqual(platform.chats.sharing, SHARING_DEFAULTS);
    // The siblings are untouched.
    assert.equal(platform.chats.retentionDays, 90);
  });

  it('creates the chats block when even that is missing', async () => {
    const { ctx } = await seed({ auth: { mode: 'local' } });
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.deepEqual(platform.chats.sharing, SHARING_DEFAULTS);
    assert.deepEqual(platform.auth, { mode: 'local' });
  });

  it('keeps every value an admin already set, and fills only the gaps', async () => {
    const { ctx } = await seed({
      chats: { sharing: { allowPublic: false, maxExpiryDays: 30 } }
    });
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.equal(platform.chats.sharing.allowPublic, false);
    assert.equal(platform.chats.sharing.maxExpiryDays, 30);
    assert.equal(platform.chats.sharing.enabled, true);
    assert.equal(platform.chats.sharing.allowUsers, true);
    assert.equal(platform.chats.sharing.defaultExpiryDays, 0);
    assert.equal(platform.chats.sharing.maxViewsCap, 0);
  });

  it('is idempotent', async () => {
    const { ctx } = await seed({});
    await up(ctx);
    const first = await ctx.readJson('config/platform.json');
    await up(ctx);
    const second = await ctx.readJson('config/platform.json');
    assert.deepEqual(second, first);
  });

  it('never creates or edits features.json', async () => {
    const { ctx, dir } = await seed({});
    await up(ctx);
    assert.equal(await ctx.fileExists('config/features.json'), false);
    assert.ok(dir);
  });
});
