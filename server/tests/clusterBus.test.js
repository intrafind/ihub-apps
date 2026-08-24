// Plain-node test (node server/tests/clusterBus.test.js).
//
// Exercises server/clusterBus.js against a real cluster: the file forks itself
// three times and drives the workers through a script. Mocking node:cluster
// would test the mock — the things most likely to break here (presence
// propagation ordering, directed vs broadcast routing, retraction when a worker
// dies) only exist in the IPC behaviour itself.
//
// The workers report through plain, un-enveloped IPC messages, which the bus
// ignores, so test traffic and bus traffic share the channel without colliding.

import assert from 'assert';
import cluster from 'node:cluster';
import {
  initPrimaryBus,
  initWorkerBus,
  createPresenceMap,
  hasRemote,
  publish,
  subscribe
} from '../clusterBus.js';

const WORKER_COUNT = 3;
/** Time allowed for an announcement to reach the primary and fan back out. */
const SETTLE_MS = 200;

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

  /** Pending replies keyed by request id. */
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

  const askAll = requestFor => Promise.all(workers.map((w, i) => ask(w, requestFor(i))));
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
    await askAll(() => ({ step: 'ready' }));

    // ---- presence propagates to the other workers, but not to the owner ----
    await ask(workers[0], { step: 'register', key: 'chat-a' });
    await settle();

    let probes = await askAll(() => ({ step: 'probe', key: 'chat-a' }));
    check('owner does not see its own registration as remote', () =>
      assert.strictEqual(probes[0].hasRemote, false)
    );
    check('other workers see the registration', () => {
      assert.strictEqual(probes[1].hasRemote, true);
      assert.strictEqual(probes[2].hasRemote, true);
    });

    // ---- a directed publish reaches only the owner ----
    await ask(workers[1], { step: 'send', key: 'chat-a', text: 'directed', directed: true });
    await settle();

    let inboxes = await askAll(() => ({ step: 'inbox' }));
    check('directed message reaches the owning worker only', () => {
      assert.deepStrictEqual(inboxes[0].inbox, ['directed']);
      assert.deepStrictEqual(inboxes[1].inbox, [], 'sender must not receive its own message');
      assert.deepStrictEqual(inboxes[2].inbox, [], 'non-owner must not receive a directed message');
    });

    // ---- an undirected publish reaches every other worker ----
    await ask(workers[1], { step: 'send', text: 'broadcast', directed: false });
    await settle();

    inboxes = await askAll(() => ({ step: 'inbox' }));
    check('broadcast reaches every worker except the sender', () => {
      assert.deepStrictEqual(inboxes[0].inbox, ['directed', 'broadcast']);
      assert.deepStrictEqual(inboxes[1].inbox, []);
      assert.deepStrictEqual(inboxes[2].inbox, ['broadcast']);
    });

    // ---- deleting the entry retracts it cluster-wide ----
    await ask(workers[0], { step: 'unregister', key: 'chat-a' });
    await settle();

    probes = await askAll(() => ({ step: 'probe', key: 'chat-a' }));
    check('unregister retracts the entry everywhere', () => {
      assert.strictEqual(probes[1].hasRemote, false);
      assert.strictEqual(probes[2].hasRemote, false);
    });

    // ---- a directed publish with no owner falls back to broadcast ----
    // Losing an event outright would be worse than a wasted fan-out: the
    // sender's presence view can legitimately be newer than the primary's.
    await ask(workers[0], { step: 'clear-inbox' });
    await ask(workers[2], { step: 'clear-inbox' });
    await ask(workers[1], { step: 'send', key: 'chat-gone', text: 'orphan', directed: true });
    await settle();

    inboxes = await askAll(() => ({ step: 'inbox' }));
    check('directed publish to an unknown owner falls back to broadcast', () => {
      assert.deepStrictEqual(inboxes[0].inbox, ['orphan']);
      assert.deepStrictEqual(inboxes[2].inbox, ['orphan']);
    });

    // ---- a dead worker's registrations are retracted ----
    // Otherwise the survivors keep relaying into a process that no longer
    // exists, and every event for that chat is silently dropped.
    await ask(workers[2], { step: 'register', key: 'chat-b' });
    await settle();

    probes = await askAll(() => ({ step: 'probe', key: 'chat-b' }));
    check("a third worker's registration is visible before it dies", () =>
      assert.strictEqual(probes[0].hasRemote, true)
    );

    const doomed = workers[2];
    const exited = new Promise(resolve => doomed.once('exit', resolve));
    doomed.kill('SIGKILL');
    await exited;
    await settle();

    const survivors = await Promise.all(
      [workers[0], workers[1]].map(w => ask(w, { step: 'probe', key: 'chat-b' }))
    );
    check('a dead worker’s registrations are retracted', () => {
      assert.strictEqual(survivors[0].hasRemote, false);
      assert.strictEqual(survivors[1].hasRemote, false);
    });
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
    console.error('\nclusterBus: FAILED');
    process.exit(1);
  }
  console.log('\nclusterBus: all checks passed');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Worker: executes the driver's steps
// ---------------------------------------------------------------------------

function runWorker() {
  initWorkerBus();

  const presence = createPresenceMap('sse');
  const inbox = [];
  subscribe('test:channel', payload => inbox.push(payload.text));

  process.on('message', msg => {
    if (!msg || typeof msg.step !== 'string') return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });

    switch (msg.step) {
      case 'ready':
        reply({ ok: true });
        break;
      case 'register':
        presence.set(msg.key, { marker: true });
        reply({ ok: true });
        break;
      case 'unregister':
        presence.delete(msg.key);
        reply({ ok: true });
        break;
      case 'probe':
        reply({ hasRemote: hasRemote('sse', msg.key) });
        break;
      case 'send':
        publish(
          'test:channel',
          { text: msg.text },
          msg.directed ? { kind: 'sse', key: msg.key } : undefined
        );
        reply({ ok: true });
        break;
      case 'inbox':
        reply({ inbox: [...inbox] });
        break;
      case 'clear-inbox':
        inbox.length = 0;
        reply({ ok: true });
        break;
      default:
        reply({ ok: false });
    }
  });
}
