// Plain-node test (node server/tests/requestThrottlerCluster.test.js).
//
// A model's `concurrency` limit holds across cluster workers: the primary
// holds the slots. Counted per worker, a limit of 1 let every worker send a
// request at once and the provider answered 429. Forks real workers, like
// clusterBus.test.js.

import assert from 'assert';
import cluster from 'node:cluster';

const RUN_MS = 120;

if (cluster.isPrimary) {
  await runPrimary();
} else {
  await runWorker();
}

/** Largest number of [start, end) intervals that overlap at any instant. */
function maxOverlap(intervals) {
  const edges = intervals.flatMap(([start, end]) => [
    [start, 1],
    [end, -1]
  ]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of edges) {
    current += delta;
    max = Math.max(max, current);
  }
  return max;
}

async function runPrimary() {
  const { initPrimaryBus } = await import('../clusterBus.js');
  await import('../requestThrottler.js'); // registers the primary's slots
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
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.step}`)), 15000);
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

  await check('a concurrency of 1 holds across workers', async () => {
    const replies = await Promise.all(
      workers.map(w => ask(w, { step: 'burst', model: 'limited-model', count: 3 }))
    );
    const intervals = replies.flatMap(r => r.intervals);
    assert.strictEqual(intervals.length, 6);
    assert.strictEqual(maxOverlap(intervals), 1, 'more than one run at a time');
  });

  await check('an unlimited model runs concurrently on every worker', async () => {
    const replies = await Promise.all(
      workers.map(w => ask(w, { step: 'burst', model: 'unlimited-model', count: 3 }))
    );
    assert.ok(maxOverlap(replies.flatMap(r => r.intervals)) > 1);
  });

  await check('a run that throws still frees its slot', async () => {
    const [failedRun] = await Promise.all([
      ask(workers[0], { step: 'throw', model: 'limited-model' })
    ]);
    assert.strictEqual(failedRun.error, 'boom');
    const replies = await Promise.all(
      workers.map(w => ask(w, { step: 'burst', model: 'limited-model', count: 1 }))
    );
    assert.strictEqual(replies.flatMap(r => r.intervals).length, 2);
  });

  for (const worker of workers) worker.kill();
  if (failed) {
    console.error('\n❌ request throttler cluster tests failed');
    process.exit(1);
  }
  console.log('\nrequestThrottlerCluster: all checks passed');
  process.exit(0);
}

async function runWorker() {
  const { initWorkerBus } = await import('../clusterBus.js');
  initWorkerBus();
  const { default: configCache } = await import('../configCache.js');
  configCache.setCacheEntry('config/platform.json', {});
  configCache.setCacheEntry('config/tools.json', []);
  configCache.setCacheEntry('config/models.json', [
    { id: 'limited-model', enabled: true, concurrency: 1 },
    { id: 'unlimited-model', enabled: true }
  ]);
  const { throttledRun } = await import('../requestThrottler.js');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  process.on('message', async msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    switch (msg.step) {
      case 'ready':
        return reply({});
      case 'burst': {
        const intervals = await Promise.all(
          Array.from({ length: msg.count }, () =>
            throttledRun(msg.model, async () => {
              const start = Date.now();
              await sleep(RUN_MS);
              return [start, Date.now()];
            })
          )
        );
        return reply({ intervals });
      }
      case 'throw':
        try {
          await throttledRun(msg.model, async () => {
            throw new Error('boom');
          });
          return reply({ error: null });
        } catch (error) {
          return reply({ error: error.message });
        }
      default:
        return reply({});
    }
  });
}
