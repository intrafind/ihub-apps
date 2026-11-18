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
const { default: configStore } = await import('../services/config/ConfigStore.js');

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

describe('refreshes that keep the old copy without throwing', () => {
  it('records a file that cannot be read (the null read), and clears it once fixed', async () => {
    const platformKey = 'config/platform.json';
    const platformPath = path.join(ROOT, 'contents', 'config', 'platform.json');
    await fs.writeFile(platformPath, JSON.stringify({ auth: { mode: 'local' } }), 'utf8');
    await configCache.refreshCacheEntry(platformKey);
    assert.equal(configCache.getRefreshErrors().length, 0);

    await fs.writeFile(platformPath, '{ not json', 'utf8');
    await configCache.refreshCacheEntry(platformKey);

    assert.equal(configCache.get(platformKey)?.data?.auth?.mode, 'local', 'the old copy stays');
    const errors = configCache.getRefreshErrors();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, platformKey);
    assert.match(errors[0].message, /platform\.json could not be read/);

    await fs.writeFile(platformPath, JSON.stringify({ auth: { mode: 'oidc' } }), 'utf8');
    await configCache.refreshCacheEntry(platformKey);
    assert.deepEqual(configCache.getRefreshErrors(), []);
  });

  it('records a best-effort loader that failed (emptyOnError)', async () => {
    const agentsKey = 'config/agents.json';
    const agentsDir = path.join(ROOT, 'contents', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    await configCache.refreshCacheEntry(agentsKey);
    assert.ok(configCache.cache.has(agentsKey));
    assert.equal(configCache.getRefreshErrors().length, 0);

    // The storage layer fails to list the directory (the cache is real; only
    // the store below it is made to fail).
    const listDocuments = configStore.listDocuments;
    configStore.listDocuments = async () => {
      throw new Error('storage unavailable');
    };
    try {
      await configCache.refreshCacheEntry(agentsKey);
    } finally {
      configStore.listDocuments = listDocuments;
    }

    const errors = configCache.getRefreshErrors();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, agentsKey);
    assert.match(errors[0].message, /storage unavailable/);

    await configCache.refreshCacheEntry(agentsKey);
    assert.deepEqual(configCache.getRefreshErrors(), []);
  });
});

describe('review round 4: obsolete reloads and clear()', () => {
  const platformKey = 'config/platform.json';
  const platformPath = path.join(ROOT, 'contents', 'config', 'platform.json');

  it('a reload that fails after a later-started one stored records nothing', async () => {
    await fs.writeFile(platformPath, JSON.stringify({ auth: { mode: 'local' } }), 'utf8');
    await configCache.refreshCacheEntry(platformKey);
    assert.deepEqual(configCache.getRefreshErrors(), []);

    // The first reload's read is held and then fails (the null read); a second
    // reload starts after it, reads the file and stores it.
    const readJson = configStore.readJson;
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });
    let platformReads = 0;
    configStore.readJson = async (relPath, ...rest) => {
      if (relPath === platformKey && ++platformReads === 1) {
        await held;
        return null;
      }
      return readJson.call(configStore, relPath, ...rest);
    };
    try {
      const older = configCache._reloadEntry(platformKey);
      await fs.writeFile(platformPath, JSON.stringify({ auth: { mode: 'oidc' } }), 'utf8');
      await configCache._reloadEntry(platformKey);
      release();
      await older;
    } finally {
      configStore.readJson = readJson;
    }

    assert.equal(configCache.get(platformKey)?.data?.auth?.mode, 'oidc');
    assert.deepEqual(configCache.getRefreshErrors(), []);
  });

  it('clear() also clears the recorded refresh errors', async () => {
    await fs.writeFile(platformPath, '{ not json', 'utf8');
    await configCache.refreshCacheEntry(platformKey);
    assert.equal(configCache.getRefreshErrors().length, 1);

    configCache.clear();

    assert.deepEqual(configCache.getRefreshErrors(), []);
  });
});
