/**
 * RunLog service tests — in-memory event stream + persistence + identity +
 * cascade delete + retention. Uses a temp dir and forceEnabled so the feature
 * flag / configCache are not involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunLog, newRunId, hashPayload } from '../../services/loop/RunLog.js';
import { resolvePrincipal, isAnonymousUser } from '../../services/loop/runIdentity.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

async function tmpLog(opts = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runlog-test-'));
  const log = new RunLog({
    baseDir,
    forceEnabled: true,
    getPlatformConfig: () => ({ runLog: { identityMode: 'default', flushIntervalMs: 50 } }),
    getFeatures: () => ({ runLog: true }),
    ...opts
  });
  return { log, baseDir };
}

test('newRunId / hashPayload basics', () => {
  assert.match(newRunId('chat'), /^chat-[0-9a-f-]{36}$/);
  assert.equal(hashPayload({ a: 1 }), hashPayload({ a: 1 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
});

test('startRun assigns seq 1 to run/start and notifies subscribers synchronously', async () => {
  const { log } = await tmpLog();
  const seen = [];
  const { runId, principal } = await log.startRun({ kind: 'chat', user: { id: 'u1', name: 'N' } });
  log.subscribe(runId, e => seen.push(e));
  assert.equal(principal.id, 'u1');
  assert.equal(principal.name, undefined, 'default mode must not record PII');
  const e2 = log.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'hi' });
  assert.equal(e2.seq, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'message/user');
  assert.equal(log.currentSeq(runId), 2);
  await log.stop();
});

test('append validates against the contract', async () => {
  const { log } = await tmpLog();
  const { runId } = await log.startRun({ kind: 'workflow', user: { id: 'u1' } });
  assert.throws(() => log.append(runId, RUN_LOG_EVENTS.TOOL_CALL, { step: 1 }), /callId|Required/);
  assert.throws(() => log.append(runId, 'nope/event', {}), /Unknown RunLog event type/);
  await log.stop();
});

test('events persist to one JSONL per run and readEvents honours afterSeq', async () => {
  const { log, baseDir } = await tmpLog();
  const { runId } = await log.startRun({ kind: 'chat', user: { id: 'u1' } });
  log.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'a' });
  log.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, { step: 1, content: 'b' });
  log.endRun(runId, { status: 'completed', finishReason: 'stop' });
  await log.flush();
  const file = path.join(baseDir, 'runs', `${runId}.jsonl`);
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 4);
  const all = await log.readEvents(runId);
  assert.deepEqual(
    all.map(e => e.type),
    ['run/start', 'message/user', 'message/assistant', 'run/end']
  );
  const tail = await log.readEvents(runId, { afterSeq: 2 });
  assert.deepEqual(
    tail.map(e => e.seq),
    [3, 4]
  );
  // A fresh instance recovers the last seq from disk via resumeRun.
  const log2 = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  await log2.resumeRun(runId);
  assert.equal(log2.currentSeq(runId), 4);
  const e = log2.append(runId, RUN_LOG_EVENTS.RUN_RESUMED, {});
  assert.equal(e.seq, 5);
  await log.stop();
  await log2.stop();
});

test('listRuns excludes anonymous runs and reflects run/end status', async () => {
  const { log } = await tmpLog();
  const a = await log.startRun({ kind: 'chat', user: { id: 'alice' } });
  const anon = await log.startRun({ kind: 'chat', user: null });
  assert.equal(anon.anonymous, true);
  assert.match(anon.runId, /^anon-[0-9a-f]{32}$/);
  log.endRun(a.runId, { status: 'completed' });
  log.endRun(anon.runId, { status: 'completed' });
  const runs = await log.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, a.runId);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].principalId, 'alice');
  // anonymous run is still readable by id possession
  const anonEvents = await log.readEvents(anon.runId);
  assert.equal(anonEvents.length, 2);
  await log.stop();
});

test('deleteRun cascades: run file, spill dir, index tombstone, hooks', async () => {
  const { log, baseDir } = await tmpLog();
  const hooked = [];
  log.onDelete(async id => {
    hooked.push(id);
    return 'interactions';
  });
  const { runId } = await log.startRun({ kind: 'agent', user: { id: 'bob' } });
  const ref = await log.spill(runId, 'tool-result-1.json', { big: 'x'.repeat(100) });
  assert.ok(ref.path.includes(runId));
  assert.equal(await log.readSpill(runId, ref), JSON.stringify({ big: 'x'.repeat(100) }));
  log.endRun(runId, { status: 'completed' });
  await log.flush();
  const res = await log.deleteRun(runId);
  assert.equal(res.deleted, true);
  assert.ok(res.cascaded.includes('run-file'));
  assert.ok(res.cascaded.includes('interactions'));
  assert.deepEqual(hooked, [runId]);
  await assert.rejects(fs.access(path.join(baseDir, 'runs', `${runId}.jsonl`)));
  await assert.rejects(fs.access(path.join(baseDir, 'spill', runId)));
  const runs = await log.listRuns();
  assert.equal(runs.length, 0, 'tombstone hides the deleted run');
  assert.equal(log.hasRun(runId), false);
  await log.stop();
});

test('persistence off: in-memory stream still works, nothing hits disk', async () => {
  const { log, baseDir } = await tmpLog({ forceEnabled: false });
  const seen = [];
  log.subscribeAll(e => seen.push(e.type));
  const { runId } = await log.startRun({ kind: 'inference', user: { id: 'u' } });
  log.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, { step: 1, content: 'x' });
  log.endRun(runId);
  await log.flush();
  assert.deepEqual(seen, ['run/start', 'message/assistant', 'run/end']);
  await assert.rejects(fs.access(path.join(baseDir, 'runs')));
  assert.deepEqual(await log.readEvents(runId), []);
  assert.equal(await log.spill(runId, 'x', 'y'), null);
  await log.stop();
});

test('cleanup removes run files older than retention', async () => {
  const { log, baseDir } = await tmpLog();
  const { runId } = await log.startRun({ kind: 'chat', user: { id: 'u' } });
  log.endRun(runId);
  await log.flush();
  const file = path.join(baseDir, 'runs', `${runId}.jsonl`);
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  await fs.utimes(file, old, old);
  const { removed } = await log.cleanup(5);
  assert.equal(removed, 1);
  await assert.rejects(fs.access(file));
  await log.stop();
});

test('identity modes: full keeps PII, default id-only, pseudonymized hashes, anonymous random', async () => {
  const user = { id: 'carol', name: 'Carol', email: 'c@example.com', groups: ['users'] };
  const full = await resolvePrincipal(user, { mode: 'full' });
  assert.deepEqual(full, {
    id: 'carol',
    mode: 'full',
    anonymous: false,
    name: 'Carol',
    email: 'c@example.com',
    groups: ['users']
  });
  const def = await resolvePrincipal(user, { mode: 'default' });
  assert.deepEqual(def, { id: 'carol', mode: 'default', anonymous: false });
  const pseudo = await resolvePrincipal(user, { mode: 'pseudonymized' });
  assert.match(pseudo.id, /^usr_[0-9a-f]{16}$/);
  const pseudo2 = await resolvePrincipal(user, { mode: 'pseudonymized' });
  assert.equal(pseudo.id, pseudo2.id, 'stable across calls');
  const anon = await resolvePrincipal({ id: 'anonymous' }, { mode: 'default' });
  assert.equal(anon.anonymous, true);
  assert.match(anon.id, /^anon-/);
  assert.equal(isAnonymousUser(null), true);
  assert.equal(isAnonymousUser({ id: 'x' }), false);
  const agent = await resolvePrincipal({ id: 'agent:p1', isAgent: true, profileId: 'p1' });
  assert.equal(agent.isAgent, true);
  assert.equal(agent.profileId, 'p1');
});

test('appendRecovered continues the persisted sequence for a run this process never started', async () => {
  const { log, baseDir } = await tmpLog();
  const { runId } = await log.startRun({ kind: 'chat', user: { id: 'u1' } });
  log.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'hi' });
  await log.flush();

  // another worker (a second RunLog over the same directory) answers into the run
  const other = new RunLog({
    baseDir,
    forceEnabled: true,
    getPlatformConfig: () => ({ runLog: { identityMode: 'default', flushIntervalMs: 50 } }),
    getFeatures: () => ({ runLog: true })
  });
  const ev = await other.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, {
    kind: 'stop',
    by: 'u1',
    at: new Date().toISOString()
  });
  assert.equal(ev.seq, 3, 'seq continues after the two persisted events');
  await other.flush();
  const events = await other.readEvents(runId);
  assert.deepEqual(
    events.map(e => e.seq),
    [1, 2, 3]
  );
  await other.stop();
  await log.stop();
});
