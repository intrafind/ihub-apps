/**
 * Both halves of configuration invalidation, and the reason there are two.
 *
 * D2: the storage provider's change notifier is added to the cluster
 * announcement, never substituted for it.
 *
 *  - `announceConfigChange` (`server/configSync.js`) rides the cluster IPC bus
 *    and is the only thing that reaches this machine's *other workers*. Under
 *    round-robin routing, dropping it would make an admin save appear to have
 *    been lost on one refresh and applied on the next, until a five-minute TTL
 *    happened to fire — which is exactly the bug `configSync` was written for.
 *  - `FilesystemChangeNotifier` is a bare per-process `EventEmitter`
 *    (`notifications: 'in-process'`). It catches writes the announcement never
 *    sees — another instance once a push-capable provider lands, or code that
 *    forgot its `refreshCacheEntry` call — and on today's provider it is a
 *    same-process no-op.
 *
 * The announcement half cannot be observed in an ordinary test process: the
 * bus is inert without an IPC channel, so `publish()` returns false and
 * nothing is sent. This file therefore forks itself once, which gives the
 * child a real channel to the parent; the child performs one admin-shaped save
 * and the parent asserts the announcement arrived as a message on the wire.
 * That is the same "fork and drive it" shape `server/tests/configSync.test.js`
 * uses, for the same reason.
 *
 * Contract: `CONFIG_STORE_CONTRACT.md` D2 and §8.
 */
import { fork } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Platform configuration as `server.js` would hand it to the bootstrap. */
const PLATFORM_CONFIG = { storage: { provider: 'filesystem', filesystem: {} } };

/** Marker the parent sets in the child's environment to select the child body. */
const CHILD_ENV = 'IHUB_CONFIG_ANNOUNCE_CHILD';

/** The page title written by the save under test, in both halves. */
const SAVED_TITLE = 'title after the admin save';

/**
 * Seed a scratch installation with the one file these tests save.
 *
 * @param {string} prefix - `mkdtemp` prefix
 * @returns {{root: string, contents: string}} Absolute paths
 */
function makeInstallation(prefix) {
  const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const contents = path.join(root, 'contents');
  fsSync.mkdirSync(path.join(contents, 'config'), { recursive: true });
  fsSync.writeFileSync(
    path.join(contents, 'config', 'ui.json'),
    JSON.stringify({ title: 'title before the admin save', pages: {} }, null, 2),
    'utf8'
  );
  return { root, contents };
}

/**
 * The forked half: perform one admin-shaped save with a live IPC channel, then
 * report what the notifier, the announcement and the cache each did.
 *
 * @returns {Promise<void>}
 */
async function runAnnounceChild() {
  const { initPrimaryBus } = await import('../clusterBus.js');
  const { getConfigSyncStats } = await import('../configSync.js');
  const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
  const { default: configStore } = await import('../services/config/ConfigStore.js');
  const { default: configCache } = await import('../configCache.js');

  // A plain fork is not a cluster worker, so `initWorkerBus()` would decline
  // and every bus export would stay a no-op. `initPrimaryBus` activates the
  // bus without that check, and `process.send` — which a fork does have — then
  // carries the announcement to the parent, standing in for the primary.
  initPrimaryBus({ getWorkers: () => [] });

  const provider = await bootstrapStorage(PLATFORM_CONFIG);
  const events = [];
  const unsubscribe = provider.notifier.subscribe(event => events.push(event));

  const ui = await configStore.readJson('config/ui.json');
  await configStore.writeJson('config/ui.json', { ...ui, title: SAVED_TITLE });
  await configCache.refreshCacheEntry('config/ui.json');

  const report = {
    childReport: true,
    notified: events.filter(
      event => event.type === 'document.put' && event.ns === 'config' && event.key === 'ui'
    ).length,
    announced: getConfigSyncStats().announced,
    cachedTitle: configCache.get('config/ui.json').data?.title
  };

  unsubscribe();
  await shutdownStorageBootstrap();
  // Disconnect only once the report has been handed to the channel: exiting
  // with a queued message would drop it and fail the parent for the wrong reason.
  process.send(report, () => process.disconnect());
}

if (process.env[CHILD_ENV] === '1') {
  await runAnnounceChild();
} else {
  const { after, before, describe, it } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;

  const installation = makeInstallation('ihub-config-invalidation-');
  // Pinned rather than inherited: a developer `.env` that sets CONTENTS_DIR
  // would otherwise move the fixture out from under these tests. The child
  // inherits both, so its installation is shaped the same way.
  process.env.APP_ROOT_DIR = installation.root;
  process.env.CONTENTS_DIR = 'contents';

  const { default: configStore } = await import('../services/config/ConfigStore.js');
  const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
  const { default: configCache } = await import('../configCache.js');

  /**
   * Poll until `check` returns true or the budget runs out.
   *
   * The cache applies change events on a short coalescing window, so a test
   * that asserted immediately would be asserting on the timer, not on the
   * behaviour.
   *
   * @param {() => boolean} check - Condition to wait for
   * @param {number} [budgetMs=2000] - How long to keep trying
   * @returns {Promise<boolean>} Whether the condition became true
   */
  async function waitFor(check, budgetMs = 2000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return check();
  }

  describe('configuration invalidation: the notifier and the cluster announcement', () => {
    before(async () => {
      const provider = await bootstrapStorage(PLATFORM_CONFIG);
      assert.equal(provider.contentsDir, installation.contents, 'the store views the fixture');
      // `configCache.initialize()` preloads nineteen critical files and every
      // locale; these tests need one entry and the subscription, so the
      // subscription is attached directly rather than through a full boot.
      assert.equal(
        configCache._subscribeToStorageChanges(),
        true,
        'the cache follows the provider change stream'
      );
    });

    after(async () => {
      configCache.storageChangeUnsubscribe?.();
      await shutdownStorageBootstrap();
      await fs.rm(installation.root, { recursive: true, force: true });
    });

    it('a config write publishes a change event', async () => {
      const events = [];
      const provider = await bootstrapStorage(PLATFORM_CONFIG);
      const unsubscribe = provider.notifier.subscribe(event => events.push(event));
      try {
        await configStore.writeJson('apps/notified.json', { id: 'notified' });
        await configStore.remove('apps/notified.json');
      } finally {
        unsubscribe();
      }

      assert.deepEqual(
        events.map(event => [event.type, event.ns, event.key]),
        [
          ['document.put', 'apps', 'notified'],
          ['document.delete', 'apps', 'notified']
        ],
        'a configuration write is a document change like any other'
      );
    });

    it('an admin save followed by refreshCacheEntry is visible to readers', async () => {
      const before = await configStore.readJson('config/ui.json');
      await configStore.writeJson('config/ui.json', { ...before, title: SAVED_TITLE });
      await configCache.refreshCacheEntry('config/ui.json');

      assert.equal(
        configCache.get('config/ui.json').data.title,
        SAVED_TITLE,
        'the read that used to be served from a 60-second TTL cache below the ' +
          'cache now sees the save immediately'
      );
    });

    it('a write nobody announced still reaches the cache through the notifier', async () => {
      // The half the announcement cannot cover: a write that skipped
      // `refreshCacheEntry`. The entry has to be cached already — the notifier
      // invalidates what the cache holds, it does not decide what to hold.
      await configCache.refreshCacheEntry('config/ui.json');
      const title = 'written without refreshing the cache';
      const current = await configStore.readJson('config/ui.json');
      await configStore.writeJson('config/ui.json', { ...current, title });

      assert.equal(
        await waitFor(() => configCache.get('config/ui.json').data?.title === title),
        true,
        'the provider change stream reloaded the entry on its own'
      );
    });

    it('refreshCacheEntry still announces the change to the other workers', async () => {
      const child = makeInstallation('ihub-config-announce-');
      const messages = [];
      const forked = fork(fileURLToPath(import.meta.url), [], {
        env: { ...process.env, [CHILD_ENV]: '1', APP_ROOT_DIR: child.root },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc']
      });

      try {
        forked.on('message', message => messages.push(message));
        const exitCode = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            forked.kill('SIGKILL');
            reject(new Error('the forked save did not finish in time'));
          }, 60_000);
          forked.on('error', error => {
            clearTimeout(timer);
            reject(error);
          });
          forked.on('exit', code => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        assert.equal(exitCode, 0, 'the forked save completed');

        const announcements = messages.filter(
          message =>
            message?.__ihubBus === true &&
            message.kind === 'publish' &&
            message.type === 'config:changed'
        );
        assert.equal(announcements.length, 1, 'exactly one announcement went out on the bus');
        assert.deepEqual(
          announcements[0].payload.entries,
          ['config/ui.json'],
          'naming the entry every other worker has to re-read'
        );

        const report = messages.find(message => message?.childReport === true);
        assert.ok(report, 'the child reported back');
        assert.equal(report.announced, 1, 'configSync counted the announcement it sent');
        assert.ok(
          report.notified >= 1,
          'and the provider notifier fired for the same write — both run, neither replaces the other'
        );
        assert.equal(report.cachedTitle, SAVED_TITLE, 'the saving worker sees its own save');
      } finally {
        if (forked.exitCode === null && forked.signalCode === null) forked.kill('SIGKILL');
        await fs.rm(child.root, { recursive: true, force: true });
      }
    });
  });
}
