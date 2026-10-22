#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V172 specs — seeding `platform.projects` and the `projects` and
 * `projectSharing` group permissions.
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
  PROJECT_DEFAULTS
} from '../migrations/V172__add_projects_settings.js';
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

async function seed({ platform = null, groups = null, features = null } = {}) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v172-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  if (groups !== null) {
    await fs.writeFile(path.join(dir, 'config/groups.json'), JSON.stringify(groups), 'utf8');
  }
  if (features !== null) {
    await fs.writeFile(path.join(dir, 'config/features.json'), JSON.stringify(features), 'utf8');
  }
  return { dir, ctx: makeCtx(dir) };
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

const builtinGroups = () => ({
  groups: {
    admins: { id: 'admins', permissions: { apps: ['*'], adminAccess: true } },
    users: { id: 'users', permissions: { apps: ['*'] } },
    authenticated: { id: 'authenticated', permissions: { apps: ['*'] } },
    anonymous: { id: 'anonymous', permissions: { apps: ['chat'] } },
    contractors: { id: 'contractors', permissions: { apps: ['chat'] } }
  }
});

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v172-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V172 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '172');
    assert.equal(description, 'add_projects_settings');
  });

  it('runs when either file exists', async () => {
    assert.equal(await precondition((await seed()).ctx), false);
    assert.equal(await precondition((await seed({ platform: {} })).ctx), true);
    assert.equal(await precondition((await seed({ groups: builtinGroups() })).ctx), true);
  });
});

describe('V172 platform.projects', () => {
  it('seeds every default on an installation without the block', async () => {
    const { dir, ctx } = await seed({ platform: { defaultLanguage: 'en' } });
    await up(ctx);
    const platform = await read(dir, 'config/platform.json');
    assert.equal(platform.defaultLanguage, 'en');
    assert.equal(platform.projects.tierPolicy, 'ihub');
    assert.equal(platform.projects.limits.maxFiles, 25);
    assert.equal(platform.projects.limits.maxFileBytes, 20 * 1024 * 1024);
    assert.equal(platform.projects.limits.maxProjectBytes, 200 * 1024 * 1024);
    assert.equal(platform.projects.limits.maxProjectsPerUser, 20);
    assert.deepEqual(platform.projects.sharing, {
      allowUsers: true,
      allowGroups: true,
      allowEveryone: false
    });
    assert.equal(platform.projects.retentionDays, 0);
    assert.equal(platform.projects.loadAllMaxTokens, 50000);
    assert.deepEqual(platform.projects.kinds, {});
    assert.equal(platform.projects.encryption.keyProvider, 'local-file');
    assert.equal(Object.keys(PROJECT_DEFAULTS).length, 12);
  });

  it('keeps what an admin already set and fills in the rest', async () => {
    const { dir, ctx } = await seed({
      platform: { projects: { limits: { maxFiles: 10 }, sharing: { allowEveryone: true } } }
    });
    await up(ctx);
    const { projects } = await read(dir, 'config/platform.json');
    assert.equal(projects.limits.maxFiles, 10);
    assert.equal(projects.limits.maxProjectsPerUser, 20);
    assert.equal(projects.sharing.allowEveryone, true);
    assert.equal(projects.sharing.allowUsers, true);
    assert.equal(projects.tierPolicy, 'ihub');
  });

  it('is idempotent', async () => {
    const { dir, ctx } = await seed({ platform: {} });
    await up(ctx);
    const first = await read(dir, 'config/platform.json');
    await up(ctx);
    assert.deepEqual(await read(dir, 'config/platform.json'), first);
  });
});

describe('V172 group permissions', () => {
  it('grants the built-in groups and leaves custom groups alone', async () => {
    const { dir, ctx } = await seed({ groups: builtinGroups() });
    await up(ctx);
    const { groups } = await read(dir, 'config/groups.json');
    for (const id of ['admins', 'users', 'authenticated']) {
      assert.equal(groups[id].permissions.projects, true, id);
      assert.equal(groups[id].permissions.projectSharing, true, id);
    }
    assert.equal(groups.anonymous.permissions.projects, false);
    assert.equal(groups.anonymous.permissions.projectSharing, false);
    assert.equal(groups.contractors.permissions.projects, undefined);
    assert.equal(groups.contractors.permissions.projectSharing, undefined);
  });

  it('never overwrites a value an admin set', async () => {
    const groups = builtinGroups();
    groups.groups.users.permissions.projects = false;
    const { dir, ctx } = await seed({ groups });
    await up(ctx);
    const stored = await read(dir, 'config/groups.json');
    assert.equal(stored.groups.users.permissions.projects, false);
    assert.equal(stored.groups.users.permissions.projectSharing, true);
  });

  it('warns and skips a groups file without a groups object', async () => {
    const { ctx } = await seed({ groups: { metadata: {} } });
    await up(ctx);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
  });

  it('does not write features.json', async () => {
    const { dir, ctx } = await seed({ platform: {}, groups: builtinGroups(), features: { x: 1 } });
    await up(ctx);
    assert.deepEqual(await read(dir, 'config/features.json'), { x: 1 });
  });
});
