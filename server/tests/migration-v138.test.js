#!/usr/bin/env node

/**
 * Migration V138 specs — seeding `platform.scheduledTasks` and the
 * `scheduledTasks` group permission.
 *
 * Defaults land where they are missing; every value an admin already set is
 * left exactly as it is, custom groups are not granted anything, and
 * `features.json` is never written.
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
  SCHEDULED_TASK_DEFAULTS
} from '../migrations/V138__scheduled_tasks_defaults.js';
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
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed({ platform = null, groups = null } = {}) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v138-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  if (groups !== null) {
    await fs.writeFile(path.join(dir, 'config/groups.json'), JSON.stringify(groups), 'utf8');
  }
  return { dir, ctx: makeCtx(dir) };
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v138-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V138 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '138');
    assert.equal(description, 'scheduled_tasks_defaults');
  });

  it('runs when either file exists', async () => {
    assert.equal(await precondition((await seed()).ctx), false);
    assert.equal(await precondition((await seed({ platform: {} })).ctx), true);
    assert.equal(await precondition((await seed({ groups: { groups: {} } })).ctx), true);
  });
});

describe('V138 platform.scheduledTasks', () => {
  it('seeds every default into an empty platform config', async () => {
    const { dir, ctx } = await seed({ platform: {} });
    await up(ctx);
    const platform = await read(dir, 'config/platform.json');
    assert.deepEqual(platform.scheduledTasks, { ...SCHEDULED_TASK_DEFAULTS });
  });

  it('keeps values an admin already set', async () => {
    const { dir, ctx } = await seed({
      platform: { scheduledTasks: { maxTasksPerUser: 3, enabled: false } }
    });
    await up(ctx);
    const { scheduledTasks } = await read(dir, 'config/platform.json');
    assert.equal(scheduledTasks.maxTasksPerUser, 3);
    assert.equal(scheduledTasks.enabled, false);
    assert.equal(scheduledTasks.minIntervalMinutes, 15);
  });
});

describe('V138 group permission', () => {
  const builtIn = () => ({
    groups: {
      admins: { id: 'admins', permissions: { adminAccess: true } },
      users: { id: 'users', permissions: {} },
      authenticated: { id: 'authenticated', permissions: {} },
      anonymous: { id: 'anonymous', permissions: {} },
      marketing: { id: 'marketing', permissions: { apps: ['*'] } }
    }
  });

  it('grants the built-in signed-in groups, denies anonymous, leaves custom groups alone', async () => {
    const { dir, ctx } = await seed({ groups: builtIn() });
    await up(ctx);
    const { groups } = await read(dir, 'config/groups.json');
    assert.equal(groups.admins.permissions.scheduledTasks, true);
    assert.equal(groups.users.permissions.scheduledTasks, true);
    assert.equal(groups.authenticated.permissions.scheduledTasks, true);
    assert.equal(groups.anonymous.permissions.scheduledTasks, false);
    assert.equal(groups.marketing.permissions.scheduledTasks, undefined);
  });

  it('never overwrites a value an admin set', async () => {
    const groups = builtIn();
    groups.groups.authenticated.permissions.scheduledTasks = false;
    const { dir, ctx } = await seed({ groups });
    await up(ctx);
    const stored = await read(dir, 'config/groups.json');
    assert.equal(stored.groups.authenticated.permissions.scheduledTasks, false);
  });

  it('never writes features.json', async () => {
    const { dir, ctx } = await seed({ platform: {}, groups: builtIn() });
    await up(ctx);
    await assert.rejects(fs.stat(path.join(dir, 'config/features.json')));
  });
});
