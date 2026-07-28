// Plain-node test (node server/tests/configSync.test.js).
//
// Exercises server/configSync.js against a real cluster: the file forks itself
// twice and drives the workers through a script. The reload implementation is
// stubbed — what is under test is the invalidation contract (does an
// announcement reach the other workers, does it stay off the announcer, are
// bursts coalesced, do hooks fire once per applied batch), not configCache's
// disk loading, which has its own coverage.
//
// Workers report through plain, un-enveloped IPC messages, which the bus
// ignores, so test traffic and bus traffic share the channel without colliding.

import assert from 'assert';
import cluster from 'node:cluster';
import { initPrimaryBus, initWorkerBus } from '../clusterBus.js';
import {
  ALL_ENTRIES,
  announceConfigChange,
  announceFullConfigReload,
  registerConfigChangeHook,
  setConfigReloader
} from '../configSync.js';

const WORKER_COUNT = 2;
/** Time allowed for an announcement to reach the primary, fan out and drain. */
const SETTLE_MS = 300;

if (cluster.isPrimary) {
  await runPrimary();
} else {
  runWorker();
}

// ---------------------------------------------------------------------------
// Primary: the test driver
// ---------------------------------------------------------------------------

async function runPrimary() {
  const workers = [];
  initPrimaryBus({ getWorkers: () => workers });

  for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(cluster.fork({ TEST_WORKER_INDEX: String(i) }));
  }

  const pending = new Map();
  let nextId = 1;

  for (const worker of workers) {
    worker.on('message', msg => {
      if (!msg || !msg.testReply) return;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
  }

  const ask = (worker, request) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`worker did not answer ${request.step} in time`));
      }, 5000);
      pending.set(id, msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      worker.send({ ...request, id });
    });

  const askAll = request => Promise.all(workers.map(w => ask(w, request)));
  const settle = () => new Promise(r => setTimeout(r, SETTLE_MS));

  let failed = false;
  const check = (label, fn) => {
    try {
      fn();
      console.log(`✅ ${label}`);
    } catch (error) {
      failed = true;
      console.error(`❌ ${label}\n   ${error.message}`);
    }
  };

  try {
    await askAll({ step: 'ready' });

    // ---- an announcement reloads the entry on the other workers only ----
    // The announcing worker already reloaded inline in its route handler;
    // reloading again there would double the work on every admin save.
    await ask(workers[0], { step: 'announce', entries: ['config/apps.json'] });
    await settle();

    let logs = await askAll({ step: 'log' });
    check('the other worker reloads the announced entry', () =>
      assert.deepStrictEqual(logs[1].reloaded, ['config/apps.json'])
    );
    check('the announcing worker does not reload it again', () =>
      assert.deepStrictEqual(logs[0].reloaded, [])
    );
    check('hooks run once on the receiving worker', () =>
      assert.deepStrictEqual(logs[1].hooks, [['config/apps.json']])
    );
    check('hooks do not run on the announcing worker', () =>
      assert.deepStrictEqual(logs[0].hooks, [])
    );

    // ---- a burst collapses into one reload per distinct entry ----
    // One admin save often refreshes several entries; reloading each once per
    // message instead of once per burst multiplies disk reads for no gain.
    await askAll({ step: 'clear-log' });
    await ask(workers[0], {
      step: 'announce-burst',
      bursts: [
        ['config/platform.json', 'config/groups.json'],
        ['config/platform.json'],
        ['config/groups.json']
      ]
    });
    await settle();

    logs = await askAll({ step: 'log' });
    check('a burst reloads each distinct entry exactly once', () =>
      assert.deepStrictEqual([...logs[1].reloaded].sort(), [
        'config/groups.json',
        'config/platform.json'
      ])
    );
    check('a coalesced burst runs hooks once', () => assert.strictEqual(logs[1].hooks.length, 1));

    // ---- a full reload is applied as one wholesale reload ----
    await askAll({ step: 'clear-log' });
    await ask(workers[0], { step: 'announce-all' });
    await settle();

    logs = await askAll({ step: 'log' });
    check('a full reload announcement triggers reloadAll, not per-entry reloads', () => {
      assert.strictEqual(logs[1].reloadAllCount, 1);
      assert.deepStrictEqual(logs[1].reloaded, []);
    });
    check('hooks see the full-reload sentinel', () =>
      assert.deepStrictEqual(logs[1].hooks, [[ALL_ENTRIES]])
    );

    // ---- a failing reload does not stop later announcements ----
    // The worker must stay usable: a bad file should cost the stale entry, not
    // every invalidation that follows.
    await askAll({ step: 'clear-log' });
    await ask(workers[1], { step: 'fail-next' });
    await ask(workers[0], { step: 'announce', entries: ['config/models.json'] });
    await settle();
    await ask(workers[0], { step: 'announce', entries: ['config/tools.json'] });
    await settle();

    logs = await askAll({ step: 'log' });
    check('a reload failure does not wedge subsequent invalidations', () =>
      assert.deepStrictEqual(logs[1].reloaded, ['config/tools.json'])
    );
  } catch (error) {
    failed = true;
    console.error(`❌ test driver failed: ${error.message}`);
  }

  for (const worker of workers) {
    try {
      worker.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  if (failed) {
    console.error('\nconfigSync: FAILED');
    process.exit(1);
  }
  console.log('\nconfigSync: all checks passed');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Worker: records what the invalidation layer asked it to do
// ---------------------------------------------------------------------------

function runWorker() {
  initWorkerBus();

  const reloaded = [];
  const hooks = [];
  let reloadAllCount = 0;
  let failNext = false;

  setConfigReloader({
    entry: async key => {
      if (failNext) {
        failNext = false;
        throw new Error(`simulated reload failure for ${key}`);
      }
      reloaded.push(key);
    },
    all: async () => {
      reloadAllCount += 1;
    }
  });

  registerConfigChangeHook(({ entries }) => {
    hooks.push([...entries].sort());
  });

  process.on('message', msg => {
    if (!msg || typeof msg.step !== 'string') return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });

    switch (msg.step) {
      case 'ready':
        reply({ ok: true });
        break;
      case 'announce':
        announceConfigChange(msg.entries);
        reply({ ok: true });
        break;
      case 'announce-burst':
        for (const entries of msg.bursts) announceConfigChange(entries);
        reply({ ok: true });
        break;
      case 'announce-all':
        announceFullConfigReload();
        reply({ ok: true });
        break;
      case 'fail-next':
        failNext = true;
        reply({ ok: true });
        break;
      case 'log':
        reply({ reloaded: [...reloaded], hooks: [...hooks], reloadAllCount });
        break;
      case 'clear-log':
        reloaded.length = 0;
        hooks.length = 0;
        reloadAllCount = 0;
        reply({ ok: true });
        break;
      default:
        reply({ ok: false });
    }
  });
}
