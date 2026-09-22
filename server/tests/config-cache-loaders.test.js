/**
 * Boot and refresh load every cache key through one loader table.
 *
 * `initialize()` and `_reloadEntry()` used to carry their own copy of each
 * type's loading logic, and the copies drifted: boot decrypted platform.json's
 * speech secrets, the refresh path did not, so the first admin save (or TTL
 * tick) put the `ENC[...]` string back in the cache and broke the realtime
 * proxy and the Azure token broker until restart. The apps/models/prompts/
 * workflows/agents refresh branches also never re-armed their TTL timer when
 * nothing had changed, so edits made outside the admin UI stopped being picked
 * up after the first quiet tick — the bug `config-cache-refresh-chain.test.js`
 * pins for groups.json.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-cache-loaders-')));
const CONTENTS = path.join(ROOT, 'contents');
fsSync.mkdirSync(path.join(CONTENTS, 'config'), { recursive: true });
fsSync.mkdirSync(path.join(CONTENTS, 'apps'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { default: configCache } = await import('../configCache.js');

const DEFAULT_APP = JSON.parse(
  fsSync.readFileSync(
    new URL('../defaults/apps/embedded-website-wikipedia.json', import.meta.url),
    'utf8'
  )
);

async function writeJson(relativePath, data) {
  await fs.writeFile(path.join(CONTENTS, relativePath), JSON.stringify(data, null, 2), 'utf8');
}

/** Wait out a few TTL ticks of the shortened timer. */
async function ticks() {
  await new Promise(resolve => setTimeout(resolve, 90));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

before(async () => {
  await tokenStorageService.initializeEncryptionKey();
});

afterEach(() => {
  for (const timer of configCache.refreshTimers.values()) clearTimeout(timer);
  configCache.refreshTimers.clear();
  configCache.cache.clear();
});

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('platform.json speech secrets', () => {
  it('are decrypted on refresh, not only at boot', async () => {
    await writeJson('config/platform.json', {
      speech: {
        realtime: { apiKey: tokenStorageService.encryptString('realtime-secret') },
        azure: { subscriptionKey: tokenStorageService.encryptString('azure-secret') }
      }
    });

    await configCache.refreshCacheEntry('config/platform.json');

    const platform = configCache.getPlatform();
    assert.equal(platform.speech.realtime.apiKey, 'realtime-secret');
    assert.equal(platform.speech.azure.subscriptionKey, 'azure-secret');
  });
});

describe('a refresh that finds nothing changed', () => {
  it('leaves the stored entry untouched', async () => {
    await writeJson('config/ui.json', { title: { en: 'iHub' } });
    await configCache.refreshCacheEntry('config/ui.json');
    const before = configCache.cache.get('config/ui.json');

    await configCache.refreshCacheEntry('config/ui.json');

    assert.equal(configCache.cache.get('config/ui.json'), before);
  });

  it('keeps the apps refresh chain alive so the next edit is picked up', async () => {
    const originalTTL = configCache.cacheTTL;
    configCache.cacheTTL = 25;
    try {
      await configCache.refreshAppsCache();
      assert.deepEqual(configCache.getApps(true).data, []);

      // Quiet ticks: the first one used to arm nothing for apps.
      await ticks();

      await writeJson('apps/wiki.json', { ...DEFAULT_APP, id: 'wiki' });
      await ticks();

      assert.deepEqual(
        configCache.getApps(true).data.map(app => app.id),
        ['wiki'],
        'an app added on disk showed up without an admin save or restart'
      );
    } finally {
      configCache.cacheTTL = originalTTL;
    }
  });
});

describe('getters on a cold cache', () => {
  it('return { data, etag } for apps, tools and prompts', () => {
    for (const getter of ['getApps', 'getTools', 'getPrompts']) {
      assert.deepEqual(configCache[getter](), { data: [], etag: null }, getter);
      assert.deepEqual(configCache[getter](true), { data: [], etag: null }, getter);
    }
  });
});
