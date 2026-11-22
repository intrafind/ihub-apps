// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Plain-node test (node server/tests/steerCluster.test.js).
//
// A message for a running answer, sent to and removed through a worker that
// does not run the answer (#3191). Forks real workers like
// chatResumeCluster.test.js: the owner holds the run and its queue, the other
// worker only has the cluster bus. The message is queued on the owner with the
// id the other worker minted; a removal asked of the other worker removes it
// on the owner, never a message of another run, and a message the owner
// already read answers "applied".

import assert from 'assert';
import cluster from 'node:cluster';
import { initPrimaryBus, initWorkerBus } from '../clusterBus.js';

const CHAT_ID = 'chat-steer-cluster-1';

if (cluster.isPrimary) {
  await runPrimary();
} else {
  await runWorker();
}

async function runPrimary() {
  const workers = [];
  initPrimaryBus({ getWorkers: () => workers });
  for (let i = 0; i < 2; i++) workers.push(cluster.fork());

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
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.step}`)), 10000);
      pending.set(id, msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      worker.send({ ...request, id });
    });
  const [owner, other] = workers;

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

  const { runId } = await ask(owner, { step: 'start' });
  const { runId: otherRunId } = await ask(owner, { step: 'start' });
  await ask(other, { step: 'seesRemote', runId });
  await ask(other, { step: 'seesRemote', runId: otherRunId });

  await check(
    'a message sent through the other worker is queued on the owner, with its id',
    async () => {
      const { routed } = await ask(other, {
        step: 'steer',
        runId,
        steerId: 'm-1',
        message: 'Use EUR'
      });
      assert.strictEqual(routed, 'relayed');
      const { items } = await ask(other, { step: 'pending', runId });
      assert.deepStrictEqual(
        items.map(i => [i.id, i.kind, i.text]),
        [['m-1', 'steer', 'Use EUR']]
      );
      const { items: local } = await ask(owner, { step: 'localPending', runId });
      assert.deepStrictEqual(
        local.map(i => i.id),
        ['m-1'],
        'the queue is on the owner'
      );
    }
  );

  await check(
    'a removal asked of the other worker removes it on the owner; it is never read',
    async () => {
      const { result: notTheirs } = await ask(other, {
        step: 'cancel',
        runId,
        steerId: 'm-1',
        by: 'bob'
      });
      assert.strictEqual(notTheirs, 'unknown', 'a message of somebody else is unknown');
      const { result } = await ask(other, { step: 'cancel', runId, steerId: 'm-1', by: 'alice' });
      assert.strictEqual(result, 'removed');
      const { taken } = await ask(owner, { step: 'take', runId });
      assert.deepStrictEqual(taken, [], 'the removed message is not read');
    }
  );

  await check('a removal never reaches the message of another run', async () => {
    await ask(other, { step: 'steer', runId: otherRunId, steerId: 'm-2', message: 'Other run' });
    const { result } = await ask(other, { step: 'cancel', runId, steerId: 'm-2', by: 'alice' });
    assert.strictEqual(result, 'unknown');
    const { items } = await ask(owner, { step: 'localPending', runId: otherRunId });
    assert.deepStrictEqual(
      items.map(i => i.id),
      ['m-2'],
      'still queued for its own run'
    );
  });

  await check(
    'a message the owner read answers "applied" to a removal through the other worker',
    async () => {
      await ask(other, { step: 'steer', runId, steerId: 'm-3', message: 'Skip the appendix' });
      const { taken } = await ask(owner, { step: 'take', runId });
      assert.deepStrictEqual(taken, ['m-3']);
      const { result } = await ask(other, { step: 'cancel', runId, steerId: 'm-3', by: 'alice' });
      assert.strictEqual(result, 'applied');
    }
  );

  await check(
    'after the end of the answer the owner refuses a message sent through the other worker',
    async () => {
      await ask(other, {
        step: 'steer',
        runId,
        steerId: 'm-4',
        mode: 'afterwards',
        message: 'Then this'
      });
      const { leftover } = await ask(owner, { step: 'close', runId });
      assert.deepStrictEqual(leftover, [['m-4', 'afterwards']]);
      const { routed } = await ask(other, {
        step: 'steer',
        runId,
        steerId: 'm-5',
        message: 'Too late'
      });
      assert.strictEqual(routed, null);
    }
  );

  for (const worker of workers) worker.kill();
  if (failed) {
    console.error('\n❌ steer cluster tests failed');
    process.exit(1);
  }
  console.log('\nsteerCluster: all checks passed');
  process.exit(0);
}

async function runWorker() {
  initWorkerBus();
  const {
    default: runLog,
    newRunId,
    RUN_PRESENCE_KIND
  } = await import('../services/loop/RunLog.js');
  const { hasRemote } = await import('../clusterBus.js');
  const steering = await import('../services/loop/steering.js');

  process.on('message', async msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    switch (msg.step) {
      case 'ready':
        return reply({});
      case 'start': {
        const { runId } = await runLog.startRun({
          kind: 'chat',
          runId: newRunId('chat'),
          principal: { id: 'alice', mode: 'default', anonymous: false },
          refs: { chatId: CHAT_ID }
        });
        return reply({ runId });
      }
      case 'seesRemote': {
        const until = Date.now() + 5000;
        while (!hasRemote(RUN_PRESENCE_KIND, msg.runId)) {
          if (Date.now() > until) throw new Error('the run never became visible');
          await new Promise(r => setTimeout(r, 10));
        }
        return reply({});
      }
      case 'steer':
        return reply({
          routed: await steering.steerRun(msg.runId, {
            id: msg.steerId,
            mode: msg.mode,
            message: msg.message,
            by: 'alice',
            chatId: CHAT_ID
          })
        });
      case 'pending':
        return reply({ items: await steering.listPendingSteers(msg.runId) });
      case 'localPending':
        return reply({ items: steering.pendingSteers(msg.runId) });
      case 'cancel':
        return reply({
          result: await steering.cancelSteer(msg.runId, msg.steerId, { by: msg.by })
        });
      case 'take':
        return reply({ taken: steering.takeSteers(msg.runId).map(s => s.id) });
      case 'close':
        return reply({
          leftover: steering.closeSteering(msg.runId).map(e => [e.id, e.mode])
        });
      default:
        return reply({});
    }
  });
}
