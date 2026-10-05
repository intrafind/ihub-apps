#!/usr/bin/env node

/**
 * Migration V152 specs — seeding `platform.userSkills`.
 *
 * The migration adds the built-in defaults where they are missing and leaves
 * every value an admin already set exactly as it is.
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
} from '../migrations/V152__add_user_skills_settings.js';
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
  const dir = await fs.mkdtemp(path.join(baseDir, 'v152-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  return makeCtx(dir);
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v152-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V152', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '152');
    assert.equal(description, 'add_user_skills_settings');
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(await seed(null)), false);
    assert.equal(await precondition(await seed({})), true);
  });

  it('adds the defaults the code falls back to', async () => {
    const ctx = await seed({ chats: { enabled: true } });
    await up(ctx);
    const platform = await ctx.readJson('config/platform.json');
    assert.deepEqual(platform.userSkills, {
      ...DEFAULT_USER_SKILL_SETTINGS,
      sharing: { ...DEFAULT_USER_SKILL_SETTINGS.sharing, restrictToGroups: [] }
    });
    assert.deepEqual(platform.chats, { enabled: true });
  });

  it('keeps what an admin set and is idempotent', async () => {
    const ctx = await seed({
      userSkills: { enabled: false, sharing: { allowEveryone: false, restrictToGroups: ['x'] } }
    });
    await up(ctx);
    const first = await ctx.readJson('config/platform.json');
    assert.equal(first.userSkills.enabled, false);
    assert.equal(first.userSkills.sharing.allowEveryone, false);
    assert.deepEqual(first.userSkills.sharing.restrictToGroups, ['x']);
    assert.equal(first.userSkills.sharing.allowGroups, true);
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/platform.json'), first);
  });
});
