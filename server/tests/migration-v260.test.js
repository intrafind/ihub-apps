#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V260 specs — seeding `platform.userApps` and the `userApps` and
 * `userAppSharing` group permissions.
 *
 * Defaults land where they are missing; every value an admin already set is
 * left exactly as it is, custom groups are not granted anything, a second run
 * changes nothing, and `features.json` is never written.
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
  USER_APP_DEFAULTS
} from '../migrations/V260__add_user_apps_settings.js';
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
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed({ platform = null, groups = null, features = null } = {}) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v260-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  const write = (name, data) =>
    fs.writeFile(path.join(dir, 'config', name), JSON.stringify(data), 'utf8');
  if (platform !== null) await write('platform.json', platform);
  if (groups !== null) await write('groups.json', groups);
  if (features !== null) await write('features.json', features);
  return { dir, ctx: makeCtx(dir) };
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
const exists = (dir, rel) =>
  fs
    .stat(path.join(dir, rel))
    .then(() => true)
    .catch(() => false);

const builtinGroups = () => ({
  groups: {
    admins: { id: 'admins', permissions: { apps: ['*'], adminAccess: true } },
    users: { id: 'users', permissions: { apps: ['*'] } },
    authenticated: { id: 'authenticated', permissions: { apps: ['*'] } },
    anonymous: { id: 'anonymous', permissions: { apps: ['chat'] } },
    marketing: { id: 'marketing', permissions: { apps: ['chat'] } }
  }
});

const EXPECTED_BLOCK = {
  limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5, ownerSnapshotMaxAgeDays: 30 },
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowPublish: false },
  capabilities: {
    modelChoice: true,
    upload: true,
    webSearch: false,
    skills: false,
    integrations: []
  },
  publishing: { adminEnables: 'withTools' },
  blockedOwners: []
};

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v260-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V260 add_user_apps_settings', () => {
  it('names itself as the file does', () => {
    assert.equal(version, '260');
    assert.equal(description, 'add_user_apps_settings');
  });

  it('runs when either file exists, and not on an empty contents directory', async () => {
    assert.equal(await precondition((await seed({ platform: {} })).ctx), true);
    assert.equal(await precondition((await seed({ groups: builtinGroups() })).ctx), true);
    assert.equal(await precondition((await seed()).ctx), false);
  });

  it('seeds platform.userApps with the defaults of the settings reader', async () => {
    const { dir, ctx } = await seed({
      platform: { defaultLanguage: 'de' },
      groups: builtinGroups()
    });
    await up(ctx);
    const platform = await read(dir, 'config/platform.json');
    assert.deepEqual(platform.userApps, EXPECTED_BLOCK);
    assert.deepEqual(platform.userApps, JSON.parse(JSON.stringify(DEFAULT_USER_APP_SETTINGS)));
    assert.deepEqual(userAppSettings(platform), EXPECTED_BLOCK);
    assert.equal(platform.defaultLanguage, 'de', 'the rest of the file is kept');
  });

  it('seeds publishing as off', async () => {
    const { dir, ctx } = await seed({ platform: {} });
    await up(ctx);
    const platform = await read(dir, 'config/platform.json');
    assert.equal(platform.userApps.sharing.allowPublish, false);
    assert.equal(USER_APP_DEFAULTS['sharing.allowPublish'], false);
  });

  it('gives both permissions to the built-in groups of signed-in users, and not to anonymous', async () => {
    const { dir, ctx } = await seed({ platform: {}, groups: builtinGroups() });
    await up(ctx);
    const { groups } = await read(dir, 'config/groups.json');
    for (const id of ['admins', 'users', 'authenticated']) {
      assert.equal(groups[id].permissions.userApps, true, `${id}.userApps`);
      assert.equal(groups[id].permissions.userAppSharing, true, `${id}.userAppSharing`);
    }
    assert.equal(groups.anonymous.permissions.userApps, false);
    assert.equal(groups.anonymous.permissions.userAppSharing, false);
    assert.deepEqual(groups.admins.permissions.apps, ['*'], 'other permissions are kept');
  });

  it('gives a custom group nothing', async () => {
    const { dir, ctx } = await seed({ platform: {}, groups: builtinGroups() });
    await up(ctx);
    const { groups } = await read(dir, 'config/groups.json');
    assert.deepEqual(groups.marketing.permissions, { apps: ['chat'] });
  });

  it('leaves every value an admin set alone', async () => {
    const groups = builtinGroups();
    groups.groups.users.permissions.userApps = false;
    groups.groups.anonymous.permissions.userAppSharing = true;
    const platform = {
      userApps: {
        limits: { maxAppsPerUser: 3 },
        sharing: { allowEveryone: true, allowPublish: true },
        capabilities: {
          webSearch: true,
          integrations: [{ id: 'jira', actions: ['search_issues'] }]
        },
        publishing: { adminEnables: 'always' },
        blockedOwners: ['mallory']
      }
    };
    const { dir, ctx } = await seed({ platform, groups });
    await up(ctx);

    const after = (await read(dir, 'config/platform.json')).userApps;
    assert.equal(after.limits.maxAppsPerUser, 3);
    assert.equal(after.limits.maxOpenOffersPerUser, 5, 'a missing key is seeded');
    assert.equal(after.sharing.allowEveryone, true);
    assert.equal(after.sharing.allowPublish, true);
    assert.equal(after.sharing.allowUsers, true);
    assert.equal(after.capabilities.webSearch, true);
    assert.equal(after.capabilities.skills, false);
    assert.deepEqual(after.capabilities.integrations, [{ id: 'jira', actions: ['search_issues'] }]);
    assert.equal(after.publishing.adminEnables, 'always');
    assert.deepEqual(after.blockedOwners, ['mallory']);

    const stored = (await read(dir, 'config/groups.json')).groups;
    assert.equal(stored.users.permissions.userApps, false, 'a set value is not touched');
    assert.equal(stored.users.permissions.userAppSharing, true, 'the other one is seeded');
    assert.equal(stored.anonymous.permissions.userAppSharing, true);
    assert.equal(stored.anonymous.permissions.userApps, false);
  });

  it('runs twice without a change', async () => {
    const { dir, ctx } = await seed({ platform: { projects: {} }, groups: builtinGroups() });
    await up(ctx);
    const platformAfterFirst = await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8');
    const groupsAfterFirst = await fs.readFile(path.join(dir, 'config/groups.json'), 'utf8');

    const second = makeCtx(dir);
    await up(second);
    assert.deepEqual(second.writes, [], 'the second run writes no file');
    assert.equal(
      await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8'),
      platformAfterFirst
    );
    assert.equal(await fs.readFile(path.join(dir, 'config/groups.json'), 'utf8'), groupsAfterFirst);
  });

  it('does not share the default lists between installations', async () => {
    const first = await seed({ platform: {} });
    await up(first.ctx);
    const platform = await read(first.dir, 'config/platform.json');
    platform.userApps.blockedOwners.push('mallory');
    assert.deepEqual(USER_APP_DEFAULTS.blockedOwners, []);
    assert.deepEqual(USER_APP_DEFAULTS['capabilities.integrations'], []);
  });

  it('does not touch features.json: the feature stays off', async () => {
    const withFeatures = await seed({
      platform: {},
      groups: builtinGroups(),
      features: { userProjects: true }
    });
    await up(withFeatures.ctx);
    assert.deepEqual(await read(withFeatures.dir, 'config/features.json'), { userProjects: true });

    const without = await seed({ platform: {}, groups: builtinGroups() });
    await up(without.ctx);
    assert.equal(await exists(without.dir, 'config/features.json'), false);
    assert.equal(without.ctx.writes.includes('config/features.json'), false);
  });

  it('works with only one of the two files, and with a groups file without groups', async () => {
    const onlyPlatform = await seed({ platform: {} });
    await up(onlyPlatform.ctx);
    assert.deepEqual(
      (await read(onlyPlatform.dir, 'config/platform.json')).userApps,
      EXPECTED_BLOCK
    );
    assert.equal(await exists(onlyPlatform.dir, 'config/groups.json'), false);

    const onlyGroups = await seed({ groups: builtinGroups() });
    await up(onlyGroups.ctx);
    assert.equal(
      (await read(onlyGroups.dir, 'config/groups.json')).groups.users.permissions.userApps,
      true
    );
    assert.equal(await exists(onlyGroups.dir, 'config/platform.json'), false);

    const broken = await seed({ platform: {}, groups: { metadata: {} } });
    await up(broken.ctx);
    assert.ok(broken.ctx.logs.some(([level]) => level === 'warn'));
    assert.deepEqual(await read(broken.dir, 'config/groups.json'), { metadata: {} });
  });
});
