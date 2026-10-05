#!/usr/bin/env node

/**
 * Migration V154 specs — seeding `platform.userSkills.allowMarketplace`.
 *
 * The migration adds the built-in default where it is missing and leaves a
 * value an admin already set, and the rest of the block, exactly as it is.
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
} from '../migrations/V154__add_user_skills_marketplace.js';
import { setDefault } from '../migrations/utils.js';
import { DEFAULT_USER_SKILL_SETTINGS } from '../services/skills/userSkillSettings.js';

let baseDir;

function makeCtx(dir) {
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
    setDefault,
    log: () => {},
    warn: () => {}
  };
}

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v154-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  return makeCtx(dir);
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v154-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V154', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '154');
    assert.equal(description, 'add_user_skills_marketplace');
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(await seed(null)), false);
    assert.equal(await precondition(await seed({})), true);
  });

  it('adds the default the code falls back to, next to the existing settings', async () => {
    const ctx = await seed({ userSkills: { enabled: true, maxSkillsPerUser: 10 } });
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.equal(
      platform.userSkills.allowMarketplace,
      DEFAULT_USER_SKILL_SETTINGS.allowMarketplace
    );
    assert.equal(platform.userSkills.allowMarketplace, true);
    assert.equal(platform.userSkills.maxSkillsPerUser, 10);
  });

  it('keeps what an admin set and is idempotent', async () => {
    const ctx = await seed({ userSkills: { allowMarketplace: false } });
    await up(ctx);
    const first = await ctx.readJson('config/platform.json');
    assert.equal(first.userSkills.allowMarketplace, false);
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/platform.json'), first);
  });
});
