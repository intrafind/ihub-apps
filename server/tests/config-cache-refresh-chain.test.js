/**
 * The TTL re-read has to keep re-reading.
 *
 * `configCache` serves every read from memory — `get()` is a plain map lookup
 * with no timestamp check — so the only thing that notices a file edited
 * outside the admin UI is the periodic re-read. The timer that drives it used
 * to be armed exclusively inside `setCacheEntry`, while several `_reloadEntry`
 * branches call that only when the etag has actually changed. The first tick
 * that found a file unchanged therefore armed nothing, and the entry stopped
 * refreshing for the life of the process.
 *
 * For `groups.json` that is a permissions bug: an operator dropping
 * `adminAccess` from a group on the box keeps granting `/api/admin/*` to it
 * indefinitely, on every worker, with nothing in the logs. The provider's
 * change stream does not cover it either — it publishes writes that went
 * through the provider, never an operator's editor.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-cache-ttl-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { default: configCache } = await import('../configCache.js');

const GROUPS_KEY = 'config/groups.json';
const groupsPath = path.join(ROOT, 'contents', 'config', 'groups.json');

/** Write `groups.json` behind the cache's back, as an operator's editor would. */
async function writeGroups(groups) {
  await fs.writeFile(groupsPath, JSON.stringify({ groups }, null, 2), 'utf8');
}

/** Let the queued microtasks and the fake timer's callbacks settle. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

before(async () => {
  await writeGroups({ editors: { id: 'editors', permissions: { adminAccess: true } } });
});

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the TTL refresh chain survives a tick that finds nothing changed', () => {
  it('re-arms and then picks up the next edit', async () => {
    // A TTL short enough to drive by hand. Real timers, because the reload is
    // async and a fake clock would have to be advanced between every await.
    const cache = configCache;
    const originalTTL = cache.cacheTTL;
    cache.cacheTTL = 25;
    try {
      await cache.refreshCacheEntry(GROUPS_KEY);
      assert.equal(
        cache.get(GROUPS_KEY)?.data?.groups?.editors?.permissions?.adminAccess,
        true,
        'the cache is warm'
      );

      // Two ticks with the file unchanged. The second is the one that used to
      // be impossible: nothing armed a timer after the first.
      await new Promise(resolve => setTimeout(resolve, 90));
      await settle();

      // Now an operator revokes it on the box.
      await writeGroups({ editors: { id: 'editors', permissions: { adminAccess: false } } });
      await new Promise(resolve => setTimeout(resolve, 90));
      await settle();

      assert.equal(
        cache.get(GROUPS_KEY)?.data?.groups?.editors?.permissions?.adminAccess,
        false,
        'the revocation took effect without an admin save or a restart'
      );
    } finally {
      cache.cacheTTL = originalTTL;
      for (const timer of cache.refreshTimers.values()) clearTimeout(timer);
      cache.refreshTimers.clear();
    }
  });
});
