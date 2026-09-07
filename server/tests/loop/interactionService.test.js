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
  const workerA = new InteractionService({ runLog, bus, pid: 1, saveIntervalMs: 10 });
  const workerB = new InteractionService({ runLog, bus, pid: 2, saveIntervalMs: 10 });
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
  await until(() => calls.includes('alice'));
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
  const workerA = new InteractionService({ runLog, bus, pid: 1, saveIntervalMs: 10 });
  const workerB = new InteractionService({ runLog, bus, pid: 2, saveIntervalMs: 10 });
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
  let claimed = false;
  workerA.onAnswer(() => {
    claimed = true;
    return gate;
  });
  const first = workerA.answer(it.id, { value: 'approve' }, { user: { id: 'alice' } });
  await until(() => claimed);
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

async function until(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}

test('cluster: the shared-filesystem claim decides when a replica lags behind', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-lag-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const { runId } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });
  // Two workers whose buses are NOT connected: B only knows what the shared
  // store holds, so its replica never learns about A's claim or answer.
  const workerA = new InteractionService({ runLog, bus: fakeBus(), pid: 1, saveIntervalMs: 10 });
  const it = await workerA.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'Approve?', options: [{ value: 'approve', label: 'Approve' }] }
  });
  await workerA.flush();
  const workerB = new InteractionService({ runLog, bus: fakeBus(), pid: 2, saveIntervalMs: 10 });
  assert.equal((await workerB.get(it.id)).status, 'pending');

  const calls = [];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  workerA.onAnswer(async () => {
    calls.push('A');
    await gate;
  });
  workerB.onAnswer(() => calls.push('B'));

  const first = workerA.answer(it.id, { value: 'approve' }, { user: { id: 'alice' } });
  await until(() => calls.includes('A'));
  // B sees "pending" and no replicated claim — the marker on disk still rejects it
  await assert.rejects(
    workerB.answer(it.id, { value: 'approve' }, { user: { id: 'bob' } }),
    e => e.code === 'ANSWER_IN_PROGRESS' && e.status === 409
  );
  release();
  assert.equal((await first).status, 'answered');

  // After A is done, B's replica is still stale, yet a second answer is not a
  // second resume: the settled marker says the interaction is answered.
  assert.equal((await workerB.get(it.id)).status, 'pending');
  await assert.rejects(
    workerB.answer(it.id, { value: 'approve' }, { user: { id: 'bob' } }),
    e => e.code === 'NOT_PENDING' && e.status === 409
  );
  assert.deepEqual(calls, ['A'], 'the run was resumed exactly once');

  const markers = await fs.readdir(path.join(baseDir, 'interaction-claims'));
  assert.equal(markers.length, 1);
  await workerA.stop();
  await workerB.stop();
  await runLog.stop();
});

test('pending interactions are persisted even when the run ledger is disabled', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-noledger-'));
  const runLog = new RunLog({
    baseDir,
    forceEnabled: false,
    getPlatformConfig: () => ({}),
    getFeatures: () => ({})
  });
  assert.equal(runLog.isEnabled(), false);
  const svc = new InteractionService({ runLog, saveIntervalMs: 10 });
  const it = await svc.raise({
    runId: 'run-noledger',
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Still here after a restart?' }
  });
  await svc.flush();
  const raw = JSON.parse(await fs.readFile(path.join(baseDir, 'interactions.json'), 'utf8'));
  assert.equal(raw.interactions[it.id].status, 'pending');
  const again = new InteractionService({ runLog, saveIntervalMs: 10 });
  assert.equal((await again.get(it.id)).status, 'pending');
  await svc.stop();
  await again.stop();
  await runLog.stop();
});

test("answer.by is recorded in the run's identity mode, never as the raw user id when pseudonymized", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-actor-'));
  const runLog = new RunLog({
    baseDir,
    forceEnabled: true,
    getPlatformConfig: () => ({ runLog: { identityMode: 'pseudonymized' } })
  });
  const svc = new InteractionService({ runLog, saveIntervalMs: 10 });
  const { runId, principal } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });
  assert.notEqual(principal.id, 'u1');
  const ledger = [];
  runLog.subscribe(runId, e => ledger.push(e));
  const it = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Proceed?' },
    source: { principalId: principal.id, identityMode: 'pseudonymized' }
  });
  const answered = await svc.answer(it.id, { value: 'yes' }, { user: { id: 'u1' } });
  assert.equal(answered.answer.by, principal.id, 'the same hash the run principal carries');
  const event = ledger.find(e => e.type === 'interaction/answered');
  assert.equal(event.data.answer.by, principal.id);
  assert.equal(JSON.stringify(event).includes('"u1"'), false);
  // anonymous users stay the literal marker
  const it2 = await svc.raise({
    runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: '?' }
  });
  const anon = await svc.answer(it2.id, { value: 'x' }, { user: null });
  assert.equal(anon.answer.by, 'anonymous');
  await svc.stop();
  await runLog.stop();
});

test("prompt.validation is enforced server-side according to the prompt's input type", async () => {
  const { runLog, svc, runId } = await setup();
  const raise = prompt => svc.raise({ runId, kind: 'question', origin: 'tool', prompt });

  const number = await raise({
    message: 'How many?',
    inputType: 'number',
    validation: { min: 1, max: 10, message: 'Pick 1 to 10' }
  });
  await assert.rejects(
    svc.answer(number.id, { value: 42 }),
    e => e.code === 'VALIDATION_FAILED' && e.message === 'Pick 1 to 10'
  );
  await assert.rejects(
    svc.answer(number.id, { value: 'many' }),
    e => e.code === 'VALIDATION_FAILED'
  );
  assert.equal((await svc.answer(number.id, { value: '7' })).answer.value, '7');

  const text = await raise({
    message: 'Ticket id?',
    inputType: 'text',
    validation: { pattern: '^[A-Z]+-\\d+$', max: 12 }
  });
  await assert.rejects(
    svc.answer(text.id, { value: 'not a ticket' }),
    e => e.code === 'VALIDATION_FAILED' && /format/.test(e.message)
  );
  await assert.rejects(
    svc.answer(text.id, { value: 'ABC-1234567890' }),
    e => e.code === 'VALIDATION_FAILED' && /at most 12/.test(e.message)
  );
  assert.equal((await svc.answer(text.id, { value: 'ABC-42' })).status, 'answered');

  const multi = await raise({
    message: 'Pick two',
    inputType: 'multi_select',
    options: ['a', 'b', 'c'].map(v => ({ value: v, label: v })),
    validation: { min: 1, max: 2 }
  });
  await assert.rejects(
    svc.answer(multi.id, { value: ['a', 'b', 'c'] }),
    e => e.code === 'VALIDATION_FAILED' && /at most 2/.test(e.message)
  );
  assert.equal((await svc.answer(multi.id, { value: ['a', 'b'] })).status, 'answered');

  // an unsafe (ReDoS) pattern never rejects an answer, whether the denylist
  // spots it or only the execution timeout does
  const unsafe = await raise({ message: 'x', validation: { pattern: '(a+)+$' } });
  assert.equal((await svc.answer(unsafe.id, { value: 'anything' })).status, 'answered');
  const sneaky = await raise({ message: 'x', validation: { pattern: '(a|aa)+$' } });
  const started = Date.now();
  assert.equal((await svc.answer(sneaky.id, { value: `${'a'.repeat(34)}!` })).status, 'answered');
  assert.ok(Date.now() - started < 1000, 'the pattern test is cut off by its timeout');
  const long = await raise({ message: 'x', validation: { pattern: '^a+$' } });
  await assert.rejects(
    svc.answer(long.id, { value: 'a'.repeat(3000) }),
    e => e.code === 'VALIDATION_FAILED' && /too long/.test(e.message)
  );

  // skipping bypasses validation only when the prompt allows it
  const skippable = await raise({ message: 'y', allowSkip: true, validation: { min: 5 } });
  assert.equal((await svc.answer(skippable.id, { skipped: true })).answer.skipped, true);
  await svc.stop();
  await runLog.stop();
});

test('approval: admins may answer regardless of the approver groups; agents still may not', async () => {
  const { runLog, svc, runId } = await setup();
  const it = await svc.raise({
    runId,
    kind: 'approval',
    origin: 'node',
    prompt: { message: 'Approve?', options: [{ value: 'approve', label: 'Approve' }] },
    policy: { approverGroups: ['finance-approvers'] }
  });
  await assert.rejects(
    svc.answer(it.id, { value: 'approve' }, { user: { id: 'bob', groups: ['users'] } }),
    e => e.code === 'UNAUTHORIZED_APPROVER'
  );
  await assert.rejects(
    svc.answer(
      it.id,
      { value: 'approve' },
      { user: { id: 'agent:p1', isAgent: true, groups: ['admin'] } }
    ),
    e => e.code === 'APPROVER_REQUIRED'
  );
  const answered = await svc.answer(
    it.id,
    { value: 'approve' },
    { user: { id: 'root', groups: ['admin'] } }
  );
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer.by, 'root');
  await svc.stop();
  await runLog.stop();
});

test('settled interactions leave memory after the retention grace; pending ones stay', async () => {
  const { runLog, svc, runId } = await setup({ settledRetentionMs: 20 });
  const prompt = { message: 'Which region?', inputType: 'text' };
  const a = await svc.raise({ runId, kind: 'question', origin: 'tool', prompt });
  const b = await svc.raise({ runId, kind: 'question', origin: 'tool', prompt });
  await svc.answer(a.id, { value: 'EU' }, { user: { id: 'alice' } });
  assert.equal((await svc.get(a.id)).status, 'answered');

  await new Promise(r => setTimeout(r, 60));
  assert.equal(await svc.get(a.id), null, 'the answered one was dropped from memory');
  assert.equal((await svc.get(b.id)).status, 'pending', 'the pending one stays');
  assert.deepEqual(
    (await svc.listPending({ runId })).map(i => i.id),
    [b.id]
  );
  await assert.rejects(svc.answer(a.id, { value: 'EU' }), e => e.code === 'NOT_FOUND');
  await svc.stop();
  await runLog.stop();
});
