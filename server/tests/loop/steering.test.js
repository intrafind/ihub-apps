import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueSteer,
  takeSteers,
  steerRun,
  steerMessage,
  resetSteersForTests,
  STEER_MARKER,
  MAX_QUEUED_STEERS,
  STEER_TTL_MS
} from '../../services/loop/steering.js';
import { RUN_PRESENCE_KIND } from '../../services/loop/RunLog.js';

test('steer queue: oldest first, bounded, expired entries dropped, drained once', () => {
  resetSteersForTests();
  const now = 1_000_000;
  assert.equal(enqueueSteer('run-a', { message: '  first  ', by: 'alice' }, { now }), true);
  assert.equal(enqueueSteer('run-a', { message: 'second' }, { now: now + 1 }), true);
  assert.equal(enqueueSteer('run-a', { message: '   ' }), false, 'blank messages are ignored');
  assert.equal(enqueueSteer(null, { message: 'x' }), false);

  const taken = takeSteers('run-a', { now: now + 2 });
  assert.deepEqual(
    taken.map(s => s.message),
    ['first', 'second']
  );
  assert.equal(taken[0].by, 'alice');
  assert.deepEqual(takeSteers('run-a'), [], 'drained');
  assert.deepEqual(takeSteers(null), []);

  // expiry
  enqueueSteer('run-b', { message: 'old' }, { now });
  assert.deepEqual(takeSteers('run-b', { now: now + STEER_TTL_MS + 1 }), []);

  // cap keeps the newest
  for (let i = 0; i < MAX_QUEUED_STEERS + 5; i++)
    enqueueSteer('run-c', { message: `m${i}` }, { now });
  const capped = takeSteers('run-c', { now });
  assert.equal(capped.length, MAX_QUEUED_STEERS);
  assert.equal(capped[capped.length - 1].message, `m${MAX_QUEUED_STEERS + 4}`);
});

test('steerMessage carries the explicit trust marker as a user message', () => {
  const m = steerMessage({ message: 'focus on 2025 figures' });
  assert.equal(m.role, 'user');
  assert.ok(m.content.startsWith(STEER_MARKER));
  assert.match(m.content, /focus on 2025 figures$/);
  assert.equal(m._steer, true);
});

test('steerRun: queued on the owning worker, relayed to a remote owner, recorded-only otherwise', () => {
  resetSteersForTests();
  const published = [];
  const bus = {
    publish: (type, payload, route) => published.push({ type, payload, route }),
    hasRemote: (kind, key) => kind === RUN_PRESENCE_KIND && key === 'run-remote'
  };
  const runLog = {
    getRunMeta: runId =>
      runId === 'run-local'
        ? { owned: true, ended: false }
        : runId === 'run-ended'
          ? { owned: true, ended: true }
          : null
  };
  assert.equal(steerRun('run-local', { message: 'go' }, { runLog, bus }), 'queued');
  assert.deepEqual(
    takeSteers('run-local').map(s => s.message),
    ['go']
  );
  assert.equal(steerRun('run-remote', { message: 'go' }, { runLog, bus }), 'relayed');
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'run:steer');
  assert.deepEqual(published[0].route, { kind: RUN_PRESENCE_KIND, key: 'run-remote' });
  assert.equal(published[0].payload.steer.message, 'go');
  assert.equal(steerRun('run-ended', { message: 'go' }, { runLog, bus }), null);
  assert.equal(steerRun('run-unknown', { message: 'go' }, { runLog, bus }), null);
});
