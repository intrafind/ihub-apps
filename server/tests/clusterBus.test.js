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
  subscribe,
  gather,
  respond,
  respondInPrimary
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
  // The primary answers gathers about itself, as it does for the System
  // resources page's per-process snapshot.
  respondInPrimary('test:whoami', () => ({ pid: process.pid, role: 'primary' }));

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

    // ---- a shared key survives one holder letting go ----
    // `chat-durable` marks "this turn must outlive its client", and turns on
    // one chat overlap by design, so two workers hold the same key at once.
    // Under the exclusive rule the second `set` took the key from the first and
    // the second `delete` then retracted it outright — while the first worker
    // was still generating. A third worker holding the browser's stream then
    // sees an ephemeral chat and relays an abort on disconnect, killing the
    // answer durability exists to protect. Nothing logs it.
    await ask(workers[0], { step: 'share', key: 'chat-shared' });
    await ask(workers[1], { step: 'share', key: 'chat-shared' });
    await settle();

    let shared = await askAll(() => ({ step: 'probe-shared', key: 'chat-shared' }));
    check('a third worker sees a shared key held elsewhere', () =>
      assert.strictEqual(shared[2].hasRemote, true)
    );
    check('a holder sees a shared key another worker also holds', () => {
      // Worker 0 announced first, so it got no sync of its own; it has to be
      // told that worker 1 joined it, or a run watched on both is never
      // relayed out of worker 0.
      assert.strictEqual(shared[0].hasRemote, true);
      assert.strictEqual(shared[1].hasRemote, true);
    });

    await ask(workers[1], { step: 'unshare', key: 'chat-shared' });
    await settle();

    shared = await askAll(() => ({ step: 'probe-shared', key: 'chat-shared' }));
    check('one holder letting go does not retract a key another still holds', () => {
      // The assertion that matters: every worker still answers "durable",
      // including the one that let go (its own turn is over, worker 0's is
      // not) and the one that never held it, which is the worker most likely
      // to be holding the browser's stream when it disconnects.
      assert.strictEqual(shared[0].held, true, 'worker 0 is still generating');
      assert.strictEqual(shared[1].held, true, 'worker 1 let go but worker 0 has not');
      assert.strictEqual(shared[2].held, true, 'worker 2 never held it and must still see it');
      assert.strictEqual(shared[1].local, false, 'worker 1 really did let go locally');
      assert.strictEqual(shared[2].local, false);
    });
    check('the last remaining holder no longer sees it held elsewhere', () => {
      assert.strictEqual(shared[0].hasRemote, false, 'only worker 0 holds it now');
      assert.strictEqual(shared[1].hasRemote, true, 'worker 0 still holds it');
    });

    await ask(workers[0], { step: 'unshare', key: 'chat-shared' });
    await settle();

    shared = await askAll(() => ({ step: 'probe-shared', key: 'chat-shared' }));
    check('the last holder letting go retracts it everywhere', () => {
      assert.strictEqual(shared[2].hasRemote, false);
      // Including on the workers that held it: worker 1's mirror was given an
      // entry naming worker 0, and only a retraction sent to everyone clears
      // it. An acquisition still skips the announcer, so this is not symmetric.
      assert.strictEqual(shared[1].hasRemote, false);
      assert.strictEqual(shared[0].held, false);
    });

    // ---- gather collects every other process's answer, primary included ----
    // `request` keeps the first reply only; a question each process answers
    // about itself (its memory, its CPU) needs all of them.
    const workerPids = workers.map(w => w.process.pid);
    const gathered = await ask(workers[0], {
      step: 'gather',
      expected: WORKER_COUNT,
      timeoutMs: 3000
    });
    check('gather collects the other workers and the primary', () => {
      const pids = gathered.replies.map(r => r.pid).sort();
      assert.deepStrictEqual(pids, [process.pid, workerPids[1], workerPids[2]].sort());
      assert.ok(
        gathered.replies.some(r => r.role === 'primary'),
        'the primary answered for itself'
      );
      assert.ok(
        !gathered.replies.some(r => r.pid === workerPids[0]),
        'the asker does not answer its own question'
      );
    });
    check('gather resolves as soon as the expected replies are in', () =>
      assert.ok(gathered.elapsedMs < 2000, `took ${gathered.elapsedMs}ms`)
    );

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

    // ---- a silent process does not hang a gather ----
    // The dead worker cannot answer; the gather waits out its timeout and
    // returns what it has, so the caller can show the worker as missing.
    const partial = await ask(workers[0], {
      step: 'gather',
      expected: WORKER_COUNT,
      timeoutMs: 300
    });
    check('gather returns partial results when a process stays silent', () => {
      const pids = partial.replies.map(r => r.pid).sort();
      assert.deepStrictEqual(pids, [process.pid, workerPids[1]].sort());
      assert.ok(partial.elapsedMs >= 250, `resolved early after ${partial.elapsedMs}ms`);
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
  // A counted kind: several workers may hold one key at once, as two
  // overlapping durable turns on one chat do.
  const sharedPresence = createPresenceMap('chat-durable', { shared: true });
  const inbox = [];
  subscribe('test:channel', payload => inbox.push(payload.text));
  respond('test:whoami', () => ({ pid: process.pid, role: 'worker' }));

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
      case 'share':
        sharedPresence.set(msg.key, { marker: true });
        reply({ ok: true });
        break;
      case 'unshare':
        sharedPresence.delete(msg.key);
        reply({ ok: true });
        break;
      case 'probe-shared':
        reply({
          // What `isChatDurable` asks: is a durable turn running anywhere.
          held: sharedPresence.has(msg.key) || hasRemote('chat-durable', msg.key),
          local: sharedPresence.has(msg.key),
          hasRemote: hasRemote('chat-durable', msg.key)
        });
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
      case 'gather': {
        const started = Date.now();
        gather('test:whoami', null, { expected: msg.expected, timeoutMs: msg.timeoutMs }).then(
          replies => reply({ replies, elapsedMs: Date.now() - started })
        );
        break;
      }
      case 'clear-inbox':
        inbox.length = 0;
        reply({ ok: true });
        break;
      default:
        reply({ ok: false });
    }
  });
}
