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
