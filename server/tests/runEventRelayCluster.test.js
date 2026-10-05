// Plain-node test (node server/tests/runEventRelayCluster.test.js).
//
// A workflow or agent run executes on the worker that started it, while the
// browser watching it (the stream GET) is often attached to another worker.
// `actionTracker.watchRun()` announces the watch over the cluster bus and
// `fire-sse` events for a watched run are relayed there. This forks real
// workers, like clusterBus.test.js, because the behaviour lives in the IPC.

import assert from 'assert';
import cluster from 'node:cluster';
import { initPrimaryBus, initWorkerBus, getBusStats } from '../clusterBus.js';

/** Time allowed for an announcement or relay to reach the other worker. */
const SETTLE_MS = 250;

if (cluster.isPrimary) {
  await runPrimary();
} else {
  await runWorker();
}

async function runPrimary() {
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
  const settle = () => new Promise(r => setTimeout(r, SETTLE_MS));
  const [runner, watcher] = workers;

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

  await check('an event for a run watched on another worker is relayed there', async () => {
    await ask(watcher, { step: 'watch', runId: 'run-1' });
    await settle();
    await ask(runner, { step: 'emit', runId: 'run-1', marker: 'first' });
    await settle();
    const { received } = await ask(watcher, { step: 'received' });
    assert.strictEqual(received.length, 1, `watcher got ${received.length} events`);
    assert.strictEqual(received[0].marker, 'first');
    assert.strictEqual(received[0].chatId, 'run-1');
  });

  await check('an Error in the payload keeps its message across the relay', async () => {
    const { received } = await ask(watcher, { step: 'received' });
    assert.strictEqual(received[0].error?.message, 'node failed');
  });

  await check('the producing worker sees its own event once, never echoed back', async () => {
    const { received } = await ask(runner, { step: 'received' });
    assert.strictEqual(received.length, 1);
  });

  await check('an event for a run nobody watches elsewhere is not published', async () => {
    const before = (await ask(runner, { step: 'stats' })).published;
    await ask(runner, { step: 'emit', runId: 'run-unwatched', marker: 'x' });
    const after = (await ask(runner, { step: 'stats' })).published;
    assert.strictEqual(after, before);
  });

  await check('after the watcher stops watching, nothing more is relayed', async () => {
    await ask(watcher, { step: 'unwatch', runId: 'run-1' });
    await settle();
    await ask(runner, { step: 'emit', runId: 'run-1', marker: 'second' });
    await settle();
    const { received } = await ask(watcher, { step: 'received' });
    assert.strictEqual(received.length, 1, 'a second event arrived after unwatch');
  });

  await check('two watches of one run on a worker need two releases', async () => {
    await ask(watcher, { step: 'watch', runId: 'run-2' });
    await ask(watcher, { step: 'watch', runId: 'run-2' });
    await ask(watcher, { step: 'unwatch', runId: 'run-2' });
    await settle();
    await ask(runner, { step: 'emit', runId: 'run-2', marker: 'still-watched' });
    await settle();
    const { received } = await ask(watcher, { step: 'received' });
    assert.ok(received.some(e => e.marker === 'still-watched'));
  });

  await check('relays when the producing worker was the first to watch the run', async () => {
    // The producer's own stream registered first, so the bus had told the
    // producer nothing about the watcher that joined later.
    await ask(runner, { step: 'watch', runId: 'run-3' });
    await settle();
    await ask(watcher, { step: 'watch', runId: 'run-3' });
    await settle();
    await ask(runner, { step: 'emit', runId: 'run-3', marker: 'producer-watched-first' });
    await settle();
    const { received } = await ask(watcher, { step: 'received' });
    assert.ok(received.some(e => e.marker === 'producer-watched-first'));
  });

  await check('a sub-workflow’s events reach the watchers of the run that spawned it', async () => {
    // The stream watches the parent and only learns the child ids from the
    // events themselves; the child's first events must not depend on that.
    await ask(watcher, { step: 'watch', runId: 'parent-run' });
    await settle();
    const spawn = (parent, child, marker) => ({
      event: 'workflow.subworkflow.start',
      chatId: parent,
      executionId: child,
      parentExecutionId: parent,
      marker
    });
    for (const payload of [
      spawn('parent-run', 'child-1', 'child-spawned'),
      { event: 'workflow.node.start', chatId: 'child-1', marker: 'child-node' },
      spawn('child-1', 'grandchild-1', 'grandchild-spawned'),
      { event: 'workflow.node.start', chatId: 'grandchild-1', marker: 'grandchild-node' }
    ]) {
      await ask(runner, { step: 'emitRaw', payload });
    }
    await settle();
    const { received } = await ask(watcher, { step: 'received' });
    const markers = received.map(e => e.marker);
    for (const marker of ['child-spawned', 'child-node', 'grandchild-spawned', 'grandchild-node']) {
      assert.strictEqual(markers.filter(m => m === marker).length, 1, `${marker} not seen once`);
    }
  });

  await check('a child watched both directly and through its parent arrives once', async () => {
    await ask(watcher, { step: 'watch', runId: 'child-1' });
    await settle();
    await ask(runner, {
      step: 'emitRaw',
      payload: { event: 'workflow.node.end', chatId: 'child-1', marker: 'child-watched-twice' }
    });
    await settle();
    const { received } = await ask(watcher, { step: 'received' });
    assert.strictEqual(received.filter(e => e.marker === 'child-watched-twice').length, 1);
  });

  for (const worker of workers) worker.kill();
  if (failed) {
    console.error('\n❌ run event relay tests failed');
    process.exit(1);
  }
  console.log('\nrunEventRelayCluster: all checks passed');
  process.exit(0);
}

async function runWorker() {
  initWorkerBus();
  const { actionTracker } = await import('../actionTracker.js');
  const received = [];
  const releases = new Map();
  actionTracker.on('fire-sse', event => received.push(event));

  process.on('message', msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    switch (msg.step) {
      case 'ready':
        return reply({});
      case 'watch': {
        const list = releases.get(msg.runId) || [];
        list.push(actionTracker.watchRun(msg.runId));
        releases.set(msg.runId, list);
        return reply({});
      }
      case 'unwatch':
        releases.get(msg.runId)?.shift()?.();
        return reply({});
      case 'emit':
        actionTracker.emit('fire-sse', {
          event: 'workflow.node.start',
          chatId: msg.runId,
          marker: msg.marker,
          error: new Error('node failed')
        });
        return reply({});
      case 'emitRaw':
        actionTracker.emit('fire-sse', msg.payload);
        return reply({});
      case 'received':
        return reply({ received: received.filter(e => e.chatId !== 'run-unwatched') });
      case 'stats':
        return reply({ published: getBusStats().published });
      default:
        return reply({});
    }
  });
}
