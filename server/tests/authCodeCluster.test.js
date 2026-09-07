// Plain-node test (node server/tests/authCodeCluster.test.js).
//
// Exercises server/utils/authorizationCodeStore.js against a real cluster: the
// file forks itself three times and drives the workers through the two halves
// of an OAuth authorization code exchange, deliberately on *different* workers.
//
// This is the shape the production bug had. `POST /api/oauth/authorize/decision`
// mints the code on one worker and the client's `POST /api/oauth/token` is
// round-robined to another, so a per-process Map answered "code not found" and
// the client saw `invalid_grant: Authorization code is invalid or expired` on
// N-1 of every N attempts. A single-process test cannot see that at all, and
// mocking node:cluster would only test the mock — the behaviour that matters
// (ownership propagation, routed consume, single-use across processes) exists
// only in the IPC path.
//
// Workers report through plain, un-enveloped IPC messages, which the bus
// ignores, so test traffic and bus traffic share the channel without colliding.

import assert from 'assert';
import cluster from 'node:cluster';
import { initPrimaryBus, initWorkerBus } from '../clusterBus.js';

const WORKER_COUNT = 3;

/** Time allowed for an ownership announcement to reach the primary and fan out. */
const SETTLE_MS = 200;

/**
 * Fixed codes so the driver can hand the same value to different workers.
 * Shape matches `generateCode()`: `<32-hex handle>.<64-hex secret>`.
 */
const HANDLE = 'f'.repeat(32);
const CODE = `${HANDLE}.${'e'.repeat(64)}`;
const OTHER_HANDLE = 'a'.repeat(32);
const OTHER_CODE = `${OTHER_HANDLE}.${'b'.repeat(64)}`;

const PAYLOAD = {
  clientId: 'test_client',
  redirectUri: 'https://example.com/callback',
  userId: 'user_123',
  scopes: ['openid', 'mcp:tools:call'],
  codeChallenge: 'challenge-value',
  codeChallengeMethod: 'S256',
  nonce: 'nonce-value'
};

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
    await Promise.all(workers.map(w => ask(w, { step: 'ready' })));

    // ---- a code minted on one worker is redeemable on another ----
    // The regression this whole change exists for.
    await ask(workers[0], { step: 'store', code: CODE, payload: PAYLOAD });
    await settle();

    const crossWorker = await ask(workers[1], { step: 'consume', code: CODE });
    check('a code minted on worker 0 is consumable on worker 1', () =>
      assert.deepStrictEqual(crossWorker.data, PAYLOAD)
    );

    // ---- single-use holds across the cluster, not just within a worker ----
    // Replay protection is the reason the code is consumed on its owner rather
    // than replicated: N copies would mean N valid redemptions.
    await settle();
    const replayElsewhere = await ask(workers[2], { step: 'consume', code: CODE });
    check('a code already consumed on another worker cannot be replayed', () =>
      assert.strictEqual(replayElsewhere.data, null)
    );

    const replayOnOwner = await ask(workers[0], { step: 'consume', code: CODE });
    check('the minting worker cannot re-consume its own spent code', () =>
      assert.strictEqual(replayOnOwner.data, null)
    );

    // ---- an unknown code is rejected without waiting for a bus timeout ----
    const unknown = await ask(workers[1], { step: 'consume', code: OTHER_CODE });
    check('an unknown code returns null', () => assert.strictEqual(unknown.data, null));

    // ---- ownership is retracted once the code is spent ----
    // A stale presence entry would send later token requests on a pointless
    // round trip to a worker that no longer holds anything.
    const owners = await Promise.all(
      workers.map(w => ask(w, { step: 'probe-remote', code: CODE }))
    );
    check('ownership of a spent code is retracted cluster-wide', () =>
      assert.deepStrictEqual(
        owners.map(o => o.hasRemote),
        [false, false, false]
      )
    );

    // ---- the secret half is never announced to other workers ----
    // Announcements are broadcast and retained for the life of the code, so
    // they must carry only the routing handle.
    await ask(workers[0], { step: 'store', code: OTHER_CODE, payload: PAYLOAD });
    await settle();
    const leak = await ask(workers[1], { step: 'scan-remote-keys', code: OTHER_CODE });
    check('presence announcements carry the handle, never the full code', () => {
      assert.strictEqual(leak.containsFullCode, false, 'full code found in presence mirror');
      assert.strictEqual(leak.containsHandle, true, 'handle should be present in presence mirror');
    });

    // ---- a valid handle with a forged secret is rejected cross-worker ----
    const forged = await ask(workers[1], {
      step: 'consume',
      code: `${OTHER_HANDLE}.${'9'.repeat(64)}`
    });
    check('a forged secret is rejected by the owning worker', () =>
      assert.strictEqual(forged.data, null)
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
    console.error('\nauthCodeCluster: FAILED');
    process.exit(1);
  }
  console.log('\nauthCodeCluster: all checks passed');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Worker: executes the driver's steps
// ---------------------------------------------------------------------------

function runWorker() {
  // Must precede any storeCode call so ownership is announced; the store module
  // itself only registers a presence map and a responder at import time.
  initWorkerBus();

  process.on('message', async msg => {
    if (!msg || typeof msg.step !== 'string') return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });

    // Imported lazily so the bus is live first, mirroring server.js's order.
    const store = await import('../utils/authorizationCodeStore.js');
    const { hasRemote } = await import('../clusterBus.js');
    const handleOf = code => String(code).split('.')[0];

    switch (msg.step) {
      case 'ready':
        reply({ ok: true });
        break;
      case 'store':
        store.storeCode(msg.code, msg.payload);
        reply({ ok: true });
        break;
      case 'consume':
        reply({ data: await store.consumeCode(msg.code) });
        break;
      case 'probe-remote':
        reply({ hasRemote: hasRemote('authcode', handleOf(msg.code)) });
        break;
      case 'scan-remote-keys':
        reply({
          containsFullCode: hasRemote('authcode', msg.code),
          containsHandle: hasRemote('authcode', handleOf(msg.code))
        });
        break;
      default:
        reply({ ok: false });
    }
  });
}
