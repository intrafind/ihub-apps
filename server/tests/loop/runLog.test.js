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

test('cleanup removes run files older than retention and runs the delete cascade', async () => {
  const { log, baseDir } = await tmpLog();
  const cascaded = [];
  log.onDelete(runId => {
    cascaded.push(runId);
    return 'interactions:1';
  });
  const { runId } = await log.startRun({ kind: 'chat', user: { id: 'u' } });
  log.endRun(runId);
  const { runId: recent } = await log.startRun({ kind: 'chat', user: { id: 'u' } });
  await log.flush();
  const file = path.join(baseDir, 'runs', `${runId}.jsonl`);
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  await fs.utimes(file, old, old);
  const { removed } = await log.cleanup(5);
  assert.equal(removed, 1);
  await assert.rejects(fs.access(file));
  assert.deepEqual(cascaded, [runId], 'the same cascade as deleteRun, for the expired run only');
  assert.equal(log.getRunMeta(runId), null);
  assert.ok(log.getRunMeta(recent));
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

/**
 * A fake cluster: per-worker buses sharing one ownership table and one set of
 * responders, so `hasRemote` / routed `request` behave like the real bus.
 */
function fakeCluster() {
  const owners = new Map(); // `${kind}:${key}` -> workerId
  const responders = new Map(); // type -> Map<workerId, handler>
  return {
    worker(id) {
      return {
        createPresenceMap(kind) {
          class PresenceMap extends Map {
            set(key, value) {
              owners.set(`${kind}:${key}`, id);
              return super.set(key, value);
            }
            delete(key) {
              if (owners.get(`${kind}:${key}`) === id) owners.delete(`${kind}:${key}`);
              return super.delete(key);
            }
            clear() {
              for (const key of [...this.keys()]) this.delete(key);
            }
          }
          return new PresenceMap();
        },
        hasRemote(kind, key) {
          const owner = owners.get(`${kind}:${key}`);
          return owner !== undefined && owner !== id;
        },
        respond(type, handler) {
          if (!responders.has(type)) responders.set(type, new Map());
          responders.get(type).set(id, handler);
          return () => responders.get(type)?.delete(id);
        },
        async request(type, payload, { route } = {}) {
          const handlers = responders.get(type) || new Map();
          const target = route ? owners.get(`${route.kind}:${route.key}`) : undefined;
          if (target !== undefined) {
            const handler = target === id ? null : handlers.get(target);
            if (!handler) return null;
            const reply = await handler(payload);
            return reply === undefined ? null : reply;
          }
          for (const [workerId, handler] of handlers) {
            if (workerId === id) continue;
            const reply = await handler(payload);
            if (reply !== undefined) return reply;
          }
          return null;
        }
      };
    }
  };
}

test('resumeRun re-reads the ledger, so the worker that lost the recovery race cannot reuse a seq', async () => {
  // Deterministic version of the ordering the concurrent test above hits by
  // chance: the worker that recovers FIRST (and so holds the lower seq) is the
  // one that later resumes the run. It used to claim ownership with its stale
  // in-memory seq and re-allocate a number the other worker had already
  // written, putting two events on the same seq in an append-only ledger.
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runlog-resume-'));
  const cluster = fakeCluster();
  const mk = id =>
    new RunLog({
      baseDir,
      forceEnabled: true,
      bus: cluster.worker(id),
      getPlatformConfig: () => ({ runLog: { identityMode: 'default', flushIntervalMs: 50 } }),
      getFeatures: () => ({ runLog: true })
    });

  const owner = mk(1);
  const { runId } = await owner.startRun({ kind: 'chat', user: { id: 'u1' } });
  owner.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'hi' }); // seq 2
  await owner.stop(); // the owner goes away; both survivors must recover

  const human = n => ({ kind: 'steer', message: `m${n}`, by: 'u1', at: new Date().toISOString() });
  const loser = mk(2);
  const winner = mk(3);

  // Sequential on purpose: `loser` recovers first and ends up on the LOWER seq.
  const first = await loser.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, human(1));
  const second = await winner.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, human(2));
  assert.equal(first.seq, 3);
  assert.equal(second.seq, 4);
  assert.equal(loser.currentSeq(runId), 3, 'the first recoverer is now behind the ledger');

  // The behind-by-one worker resumes the run and appends.
  await loser.resumeRun(runId);
  assert.equal(loser.getRunMeta(runId).owned, true);
  const appended = loser.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, human(3));
  assert.equal(appended.seq, 5, 'continues after the ledger, not after its own stale seq');

  await loser.stop();
  const events = await winner.readEvents(runId);
  assert.deepEqual(
    events.map(e => e.seq),
    [1, 2, 3, 4, 5],
    'every seq appears exactly once'
  );
  await winner.stop();
});

test('appendRecovered: the owner allocates the sequence; without an owner recovery is serialized by a lock', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runlog-cluster-'));
  const cluster = fakeCluster();
  const mk = id =>
    new RunLog({
      baseDir,
      forceEnabled: true,
      bus: cluster.worker(id),
      getPlatformConfig: () => ({ runLog: { identityMode: 'default', flushIntervalMs: 50 } }),
      getFeatures: () => ({ runLog: true })
    });
  const workerA = mk(1);
  const workerB = mk(2);

  const { runId } = await workerA.startRun({ kind: 'chat', user: { id: 'u1' } });
  workerA.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'hi' }); // seq 2, not flushed
  const seenOnA = [];
  workerA.subscribe(runId, e => seenOnA.push(e.seq));

  // B does not own the run: the append is routed to A, which continues its
  // in-memory sequence (a disk read would have missed the unflushed seq 2).
  const routed = await workerB.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, {
    kind: 'steer',
    message: 'faster',
    by: 'u1',
    at: new Date().toISOString()
  });
  assert.equal(routed.seq, 3);
  assert.deepEqual(seenOnA, [3], 'the owner appended it (its subscribers saw the event)');
  assert.equal(workerB.getRunMeta(runId), null, 'the requester did not register the run');
  assert.equal(workerA.getRunMeta(runId).owned, true);

  // The owner goes away: recovery reads the persisted ledger under the per-run
  // lock, so two workers recovering at once never allocate the same seq.
  await workerA.stop();
  const workerC = mk(3);
  const human = n => ({ kind: 'steer', message: `m${n}`, by: 'u1', at: new Date().toISOString() });
  const [fromB, fromC] = await Promise.all([
    workerB.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, human(1)),
    workerC.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, human(2))
  ]);
  assert.deepEqual([fromB.seq, fromC.seq].sort(), [4, 5]);
  assert.equal(workerB.getRunMeta(runId).owned, false, 'recovering does not take ownership');
  const events = await workerC.readEvents(runId);
  assert.deepEqual(
    events.map(e => e.seq),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(await fs.readdir(path.join(baseDir, 'locks')), [], 'locks are released');

  // A worker that resumes the run (the engine resuming a paused execution)
  // owns it again, and the others route to it.
  await workerC.resumeRun(runId);
  assert.equal(workerC.getRunMeta(runId).owned, true);
  const routedToC = await workerB.appendRecovered(runId, RUN_LOG_EVENTS.HUMAN_EVENT, human(3));
  assert.equal(routedToC.seq, 6);
  assert.equal(workerC.currentSeq(runId), 6);
  await workerB.stop();
  await workerC.stop();
});

test('run/end is idempotent, hasEnded / lastSeq / readStart use the file head and tail', async () => {
  const { log, baseDir } = await tmpLog();
  const { runId } = await log.startRun({ kind: 'chat', user: { id: 'u1' } });
  log.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'x'.repeat(200_000) });
  assert.equal(await log.hasEnded(runId), false);
  assert.ok(log.endRun(runId));
  assert.equal(log.endRun(runId), null, 'a second run/end is a no-op');
  assert.equal(await log.hasEnded(runId), true);
  await log.flush();

  // another process: no memory, answers from the file's first / last line
  const other = new RunLog({
    baseDir,
    forceEnabled: true,
    getPlatformConfig: () => ({ runLog: { identityMode: 'default', flushIntervalMs: 50 } }),
    getFeatures: () => ({ runLog: true })
  });
  assert.equal(await other.hasEnded(runId), true);
  assert.equal(await other.lastSeq(runId), 3);
  const start = await other.readStart(runId);
  assert.equal(start.type, 'run/start');
  assert.equal(start.data.principal.id, 'u1');
  assert.equal(await other.readStart('run-does-not-exist'), null);
  assert.equal(await other.hasEnded('run-does-not-exist'), false);
  await other.stop();
  await log.stop();
});

test("resolveRunMeta: a run that lives only in another worker's memory is described over the bus", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runlog-meta-'));
  const cluster = fakeCluster();
  const mk = id =>
    new RunLog({
      baseDir,
      forceEnabled: false,
      bus: cluster.worker(id),
      getPlatformConfig: () => ({ runLog: { identityMode: 'default' } })
    });
  const a = mk('A');
  const b = mk('B');
  const { runId } = await a.startRun({ kind: 'chat', user: { id: 'u1' }, refs: { chatId: 'c1' } });
  assert.equal(b.getRunMeta(runId), null, 'B never saw the run');

  const remote = await b.resolveRunMeta(runId);
  assert.equal(remote.principalId, 'u1');
  assert.equal(remote.kind, 'chat');
  assert.deepEqual(remote.refs, { chatId: 'c1' });
  assert.equal(remote.owned, false);
  assert.equal((await a.resolveRunMeta(runId)).owned, true, 'the owner answers from memory');
  assert.equal(await b.resolveRunMeta('run-nobody-owns-this'), null);
  assert.equal(await b.resolveRunMeta('../not-a-run-id'), null);

  await a.stop();
  await b.stop();
});
