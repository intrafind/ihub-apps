// Plain-node test (node server/tests/clusterRateLimitStore.test.js).
//
// The credential rate limiters count in the primary process, so a client
// spreading attempts over every worker still meets the configured limit. Forks
// real workers, like clusterBus.test.js.

import assert from 'assert';
import cluster from 'node:cluster';

if (cluster.isPrimary) {
  await runPrimary();
} else {
  await runWorker();
}

async function runPrimary() {
  const { initPrimaryBus } = await import('../clusterBus.js');
  // Importing the store registers the primary's counters, as server.js does
  // through the middleware it imports.
  await import('../utils/clusterRateLimitStore.js');
  const workers = [];
  initPrimaryBus({ getWorkers: () => workers });
  for (let i = 0; i < 2; i++) workers.push(cluster.fork({ TEST_WORKER_INDEX: String(i) }));

  const pending = new Map();
  let nextId = 1;
  for (const worker of workers) {
    worker.on('message', msg => {
      if (!msg?.testReply) return;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
  }
  const ask = (worker, request) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.step}`)), 5000);
      pending.set(id, msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      worker.send({ ...request, id });
    });

  let failed = false;
  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`✅ ${label}`);
    } catch (error) {
      failed = true;
      console.error(`❌ ${label}\n   ${error.message}`);
    }
  };

  await Promise.all(workers.map(w => new Promise(r => w.once('online', r))));
  await Promise.all(workers.map(w => ask(w, { step: 'ready' })));
  const [a, b] = workers;

  await check('hits on two workers add up to one count', async () => {
    for (let i = 0; i < 3; i++) await ask(a, { step: 'hit', store: 'auth', key: 'ip-1' });
    for (let i = 0; i < 2; i++) await ask(b, { step: 'hit', store: 'auth', key: 'ip-1' });
    const { totalHits, resetIn } = await ask(a, { step: 'hit', store: 'auth', key: 'ip-1' });
    assert.strictEqual(totalHits, 6);
    assert.ok(resetIn > 0 && resetIn <= 60_000, `reset in ${resetIn}ms`);
  });

  await check('limiters and clients are counted apart', async () => {
    assert.strictEqual((await ask(b, { step: 'hit', store: 'oauth', key: 'ip-1' })).totalHits, 1);
    assert.strictEqual((await ask(b, { step: 'hit', store: 'auth', key: 'ip-2' })).totalHits, 1);
  });

  await check('a decrement on one worker is seen by the other', async () => {
    await ask(b, { step: 'decrement', store: 'auth', key: 'ip-1' });
    assert.strictEqual((await ask(a, { step: 'hit', store: 'auth', key: 'ip-1' })).totalHits, 6);
  });

  await check('a reset on one worker clears the shared count', async () => {
    await ask(a, { step: 'reset', store: 'auth', key: 'ip-1' });
    assert.strictEqual((await ask(b, { step: 'hit', store: 'auth', key: 'ip-1' })).totalHits, 1);
  });

  for (const worker of workers) worker.kill();
  if (failed) {
    console.error('\n❌ cluster rate limit store tests failed');
    process.exit(1);
  }
  console.log('\nclusterRateLimitStore: all checks passed');
  process.exit(0);
}

async function runWorker() {
  const { initWorkerBus } = await import('../clusterBus.js');
  initWorkerBus();
  const { ClusterRateLimitStore } = await import('../utils/clusterRateLimitStore.js');
  const stores = new Map();
  const storeFor = id => {
    if (!stores.has(id)) {
      const store = new ClusterRateLimitStore(id);
      store.init({ windowMs: 60_000 });
      stores.set(id, store);
    }
    return stores.get(id);
  };

  process.on('message', async msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    switch (msg.step) {
      case 'hit': {
        const { totalHits, resetTime } = await storeFor(msg.store).increment(msg.key);
        return reply({ totalHits, resetIn: resetTime.getTime() - Date.now() });
      }
      case 'decrement':
        await storeFor(msg.store).decrement(msg.key);
        return reply({});
      case 'reset':
        await storeFor(msg.store).resetKey(msg.key);
        return reply({});
      default:
        return reply({});
    }
  });
}
