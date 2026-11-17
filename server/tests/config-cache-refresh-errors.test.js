// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A groups.json that no longer resolves (a hand edit that names a deleted
 * parent) cannot be cached: the cache keeps the last good groups. That used
 * to be visible only in the server log. It is now recorded
 * (`configCache.getRefreshErrors()`, shown in the admin Overview stats as
 * `configRefreshErrors`) until a later refresh succeeds.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-cache-err-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { default: configCache } = await import('../configCache.js');

const GROUPS_KEY = 'config/groups.json';
const groupsPath = path.join(ROOT, 'contents', 'config', 'groups.json');

async function writeGroups(groups) {
  await fs.writeFile(groupsPath, JSON.stringify({ groups }, null, 2), 'utf8');
}

before(async () => {
  await writeGroups({ editors: { id: 'editors', permissions: { adminAccess: true } } });
});

after(async () => {
  for (const timer of configCache.refreshTimers.values()) clearTimeout(timer);
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('a groups.json that does not resolve', () => {
  it('keeps the last good groups, records the failure, and clears it once fixed', async () => {
    await configCache.refreshCacheEntry(GROUPS_KEY);
    assert.deepEqual(configCache.getRefreshErrors(), []);

    await writeGroups({
      editors: { id: 'editors', inherits: ['deleted'], permissions: { adminAccess: false } }
    });
    await configCache.refreshCacheEntry(GROUPS_KEY);

    assert.equal(
      configCache.get(GROUPS_KEY)?.data?.groups?.editors?.permissions?.adminAccess,
      true,
      'the last good groups stay in force'
    );
    const errors = configCache.getRefreshErrors();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, GROUPS_KEY);
    assert.match(errors[0].message, /deleted/);

    await writeGroups({ editors: { id: 'editors', permissions: { adminAccess: false } } });
    await configCache.refreshCacheEntry(GROUPS_KEY);

    assert.deepEqual(configCache.getRefreshErrors(), []);
    assert.equal(
      configCache.get(GROUPS_KEY)?.data?.groups?.editors?.permissions?.adminAccess,
      false
    );
  });
});
