import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService, InteractionError } from '../../services/loop/InteractionService.js';

async function setup(opts = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-test-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog, saveIntervalMs: 10, ...opts });
  const { runId } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });
  return { baseDir, runLog, svc, runId };
}

test('raise → pending, ledger event, listPending, answer → answered + ledger', async () => {
  const { runLog, svc, runId } = await setup();
  const types = [];
  runLog.subscribe(runId, e => types.push(e.type));
  const it = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    step: 2,
    prompt: {
      message: 'Which region?',
      inputType: 'single_select',
      options: [{ value: 'eu', label: 'EU' }]
    },
    source: { toolCallId: 'call_1', chatId: 'chat-1' }
  });
  assert.match(it.id, /^int-/);
  assert.equal(it.status, 'pending');
  assert.equal(it.ordinal, 1);
  assert.deepEqual(await svc.listPending({ runId }), [it]);
  await assert.rejects(svc.answer(it.id, { value: 'us' }), /Invalid response 'us'/);
  const answered = await svc.answer(
    it.id,
    { value: 'eu' },
    { user: { id: 'alice' }, channel: 'chat' }
  );
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer.value, 'eu');
  assert.equal(answered.answer.by, 'alice');
  assert.equal(answered.answer.channel, 'chat');
  assert.deepEqual(types, ['interaction/raised', 'interaction/answered']);
  await assert.rejects(svc.answer(it.id, { value: 'eu' }), /is answered/);
  assert.deepEqual(await svc.listPending({ runId }), []);
  await svc.stop();
  await runLog.stop();
});

test('approval: approver groups enforced, agents rejected, reject requires reason', async () => {
  const { runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: {
      message: 'Approve?',
      options: [
        { value: 'approve', label: 'Approve' },
        { value: 'reject', label: 'Reject' }
      ]
    },
    policy: { approverGroups: ['approvers'] }
  });
  await assert.rejects(
    svc.answer(it.id, { decision: 'approve' }, { user: { id: 'bob', groups: ['users'] } }),
    e => e instanceof InteractionError && e.code === 'UNAUTHORIZED_APPROVER' && e.status === 403
  );
  await assert.rejects(
    svc.answer(
      it.id,
      { decision: 'approve' },
      { user: { id: 'agent', isAgent: true, groups: ['approvers'] } }
    ),
    e => e.code === 'APPROVER_REQUIRED'
  );
  await assert.rejects(
    svc.answer(it.id, { decision: 'reject' }, { user: { id: 'ann', groups: ['approvers'] } }),
    e => e.code === 'REASON_REQUIRED'
  );
  const ok = await svc.answer(
    it.id,
    { decision: 'approve' },
    { user: { id: 'ann', groups: ['approvers'] } }
  );
  assert.equal(ok.answer.decision, 'approve');
  assert.equal(ok.answer.value, 'approve', 'decision doubles as the routing branch value');
  // listPending filters by approver groups
  const it2 = await svc.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'x' },
    policy: { approverGroups: ['ops'] }
  });
  assert.equal((await svc.listPending({ approverGroups: ['approvers'] })).length, 0);
  assert.equal((await svc.listPending({ approverGroups: ['ops'] })).length, 1);
  assert.equal((await svc.listPending({ approverGroups: ['ops'] }))[0].id, it2.id);
  await svc.stop();
  await runLog.stop();
});

test('inputSchema validation and skip handling', async () => {
  const { runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'question',
    origin: 'node',
    prompt: {
      message: 'Fill the form',
      inputType: 'form',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, age: { type: 'number' } }
      }
    }
  });
  await assert.rejects(
    svc.answer(it.id, { value: 'ok', data: {} }),
    e => e.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    svc.answer(it.id, { value: 'ok', data: { name: 'x', age: 'old' } }),
    e => e.code === 'INVALID_INPUT'
  );
  await assert.rejects(svc.answer(it.id, { skipped: true }), e => e.code === 'SKIP_NOT_ALLOWED');
  const done = await svc.answer(it.id, { value: 'ok', data: { name: 'x', age: 3 } });
  assert.equal(done.answer.data.age, 3);
  const skippable = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'q', allowSkip: true }
  });
  const skipped = await svc.answer(skippable.id, { skipped: true });
  assert.equal(skipped.answer.skipped, true);
  await svc.stop();
  await runLog.stop();
});

test('expiry via timeoutMs, expireOverdue, and waitForAnswer', async () => {
  let now = Date.now();
  const { runLog, svc, runId } = await setup({ now: () => now });
  const it = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'q' },
    policy: { timeoutMs: 1000 }
  });
  assert.ok(it.policy.expiresAt);
  const waiting = svc.waitForAnswer(it.id);
  now += 2000;
  await assert.rejects(svc.answer(it.id, { value: 'late' }), e => e.code === 'EXPIRED');
  await assert.rejects(waiting, e => e.code === 'EXPIRED');
  const it2 = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'q2' },
    policy: { timeoutMs: 100 }
  });
  now += 500;
  const expired = await svc.expireOverdue();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, it2.id);
  const it3 = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'q3' }
  });
  const p = svc.waitForAnswer(it3.id);
  await svc.answer(it3.id, { value: 'now' });
  assert.equal((await p).answer.value, 'now');
  await svc.stop();
  await runLog.stop();
});

test('pending interactions survive a restart and are removed when the run is deleted', async () => {
  const { baseDir, runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'persist me' }
  });
  await svc.flush();
  const raw = JSON.parse(await fs.readFile(path.join(baseDir, 'interactions.json'), 'utf8'));
  assert.ok(raw.interactions[it.id]);
  // "restart": fresh service over the same store
  const svc2 = new InteractionService({ runLog, saveIntervalMs: 10 });
  const pending = await svc2.listPending({ runId });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, it.id);
  const waiter = svc2.waitForAnswer(it.id);
  const waiterRejects = assert.rejects(waiter, e => e.code === 'RUN_DELETED');
  const res = await runLog.deleteRun(runId);
  assert.ok(res.cascaded.some(c => c.startsWith('interactions:')));
  await waiterRejects;
  assert.equal((await svc2.listPending({ runId })).length, 0);
  const raw2 = JSON.parse(await fs.readFile(path.join(baseDir, 'interactions.json'), 'utf8'));
  assert.equal(Object.keys(raw2.interactions).length, 0);
  await svc.stop();
  await svc2.stop();
  await runLog.stop();
});

test('cancel rejects waiters and hides from pending', async () => {
  const { runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'notify',
    origin: 'system',
    prompt: { message: 'fyi' }
  });
  const w = svc.waitForAnswer(it.id);
  await svc.cancel(it.id, 'run aborted');
  await assert.rejects(w, e => e.code === 'CANCELLED');
  assert.equal((await svc.get(it.id)).status, 'cancelled');
  await svc.stop();
  await runLog.stop();
});

test('onAnswer handlers run before the answer is accepted; a throwing handler keeps it pending', async () => {
  const { runLog, svc, runId } = await setup();
  const seen = [];
  const unregister = svc.onAnswer((interaction, ctx) => {
    seen.push({ status: interaction.status, value: interaction.answer.value, ctx });
    if (interaction.answer.value === 'later') throw new InteractionError('not now', 'BUSY', 409);
  });
  const answeredEvents = [];
  svc.on('answered', (it, ctx) => answeredEvents.push({ id: it.id, ctx }));
  const it = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'When?' },
    source: { chatId: 'chat-9' }
  });

  await assert.rejects(
    svc.answer(it.id, { value: 'later' }, { user: { id: 'bob' }, channel: 'chat' }),
    e => e.code === 'BUSY' && e.status === 409
  );
  assert.equal((await svc.get(it.id)).status, 'pending');
  assert.deepEqual(await svc.listPending({ chatId: 'chat-9' }), [it]);
  assert.equal(answeredEvents.length, 0);

  const answered = await svc.answer(
    it.id,
    { value: 'now' },
    { user: { id: 'bob' }, channel: 'chat' }
  );
  assert.equal(answered.status, 'answered');
  assert.deepEqual(
    seen.map(s => [s.status, s.value, s.ctx.user.id, s.ctx.channel]),
    [
      ['answered', 'later', 'bob', 'chat'],
      ['answered', 'now', 'bob', 'chat']
    ]
  );
  assert.deepEqual(answeredEvents, [{ id: it.id, ctx: { user: { id: 'bob' }, channel: 'chat' } }]);
  assert.deepEqual(await svc.listPending({ chatId: 'chat-9' }), []);

  unregister();
  await svc.stop();
  await runLog.stop();
});

test('raise honours a caller-tracked ordinal', async () => {
  const { runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Third?' },
    ordinal: 3
  });
  assert.equal(it.ordinal, 3);
  await svc.stop();
  await runLog.stop();
});

// ── cluster replication ──────────────────────────────────────────────────────

/** In-memory stand-in for the cluster bus: publish fans out to every other subscriber. */
function fakeBus() {
  const handlers = new Map();
  return {
    publish(type, payload) {
      for (const h of handlers.get(type) || []) h(JSON.parse(JSON.stringify(payload)));
      return true;
    },
    subscribe(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type).delete(handler);
    }
  };
}

test('cluster: a mutation on one worker is visible on the others; waiters settle remotely', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-cluster-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const bus = fakeBus();
  const workerA = new InteractionService({ runLog, bus, pid: 1, persist: false });
  const workerB = new InteractionService({ runLog, bus, pid: 2, persist: false });
  const { runId } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });

  // raised on A → listed on B
  const raised = await workerA.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'Approve?', options: [{ value: 'approve', label: 'Approve' }] },
    source: { checkpointId: 'ckpt-1', executionId: runId }
  });
  assert.equal((await workerB.listPending({ runId })).length, 1);
  assert.equal((await workerB.get(raised.id)).status, 'pending');

  // a waiter on A is settled by an answer given on B
  const waiting = workerA.waitForAnswer(raised.id);
  const answeredEvents = [];
  workerA.on('answered', () => answeredEvents.push('A'));
  const answered = await workerB.answer(raised.id, { value: 'approve' }, { user: { id: 'alice' } });
  const seenOnA = await waiting;
  assert.equal(seenOnA.status, 'answered');
  assert.equal(seenOnA.answer.by, 'alice');
  assert.equal((await workerA.get(raised.id)).status, 'answered');
  assert.deepEqual(await workerA.listPending({ runId }), []);
  // listeners fire on the originating worker only
  assert.deepEqual(answeredEvents, []);
  assert.equal(answered.status, 'answered');

  // a stale pending copy never regresses a settled interaction
  bus.publish('interaction:mutation', { interaction: raised, pid: 3 });
  assert.equal((await workerA.get(raised.id)).status, 'answered');

  await workerA.stop();
  await workerB.stop();
  await runLog.stop();
});

test('answer: a concurrent answer is rejected while the first one is being applied; a failed handler releases the claim', async () => {
  const { runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'Approve?', options: [{ value: 'approve', label: 'Approve' }] }
  });
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const calls = [];
  svc.onAnswer(async interaction => {
    calls.push(interaction.answer.by);
    await gate;
    if (interaction.answer.by === 'fail') throw new Error('handler failed');
  });

  const first = svc.answer(it.id, { value: 'approve' }, { user: { id: 'alice' } });
  await new Promise(r => setImmediate(r));
  await assert.rejects(
    svc.answer(it.id, { value: 'approve' }, { user: { id: 'bob' } }),
    e => e.code === 'ANSWER_IN_PROGRESS' && e.status === 409
  );
  assert.deepEqual(calls, ['alice'], 'the handler ran once');
  release();
  assert.equal((await first).status, 'answered');
  assert.equal((await svc.get(it.id)).claim, undefined, 'the claim is gone once answered');

  // a failing handler releases the claim so the human can retry
  const it2 = await svc.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'Again?', options: [{ value: 'approve', label: 'Approve' }] }
  });
  await assert.rejects(
    svc.answer(it2.id, { value: 'approve' }, { user: { id: 'fail' } }),
    /handler failed/
  );
  const pending = await svc.get(it2.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.claim, undefined);
  await svc.stop();
  await runLog.stop();
});

test('cluster: a claim replicated from another worker blocks a concurrent answer there', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-claim-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const bus = fakeBus();
  const workerA = new InteractionService({ runLog, bus, pid: 1, persist: false });
  const workerB = new InteractionService({ runLog, bus, pid: 2, persist: false });
  const { runId } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });
  const it = await workerA.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'Approve?', options: [{ value: 'approve', label: 'Approve' }] }
  });
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  workerA.onAnswer(() => gate);
  const first = workerA.answer(it.id, { value: 'approve' }, { user: { id: 'alice' } });
  await new Promise(r => setImmediate(r));
  await assert.rejects(
    workerB.answer(it.id, { value: 'approve' }, { user: { id: 'bob' } }),
    e => e.code === 'ANSWER_IN_PROGRESS'
  );
  release();
  await first;
  assert.equal((await workerB.get(it.id)).status, 'answered');
  await workerA.stop();
  await workerB.stop();
  await runLog.stop();
});
