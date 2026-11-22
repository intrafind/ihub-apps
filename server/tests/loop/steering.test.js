// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The queue of messages a person sends into a running answer
 * (`services/loop/steering.js`): ids, removal against reading, the end of the
 * answer against a late message, the lifetime with an injected clock, the
 * frames the chat stream is told, and the routing to the worker that owns the
 * run. The forked-worker case is `server/tests/steerCluster.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueSteer,
  takeSteers,
  steerRun,
  steerMessage,
  cancelSteer,
  cancelQueuedSteer,
  closeSteering,
  openSteering,
  pendingSteers,
  listPendingSteers,
  settleSent,
  dropSteers,
  resetSteersForTests,
  STEER_MARKER,
  MAX_QUEUED_STEERS,
  STEER_TTL_MS,
  SEND_AFTER_TTL_MS
} from '../../services/loop/steering.js';
import { RUN_PRESENCE_KIND } from '../../services/loop/RunLog.js';
import { observeEmittedEnvelopes } from '../../services/loop/RunStream.js';
import { parseSseV2EventData } from '../../services/loop/contracts/sseV2.js';
import { neutraliseSteerMarker, hasSteerMarker } from '../../../shared/steerMarker.js';

/** The frames emitted on the chat streams while `fn` runs, each checked against its schema. */
function framesOf(fn) {
  const frames = [];
  const stop = observeEmittedEnvelopes(envelope => {
    if (!envelope.type.startsWith('steer/')) return;
    parseSseV2EventData(envelope.type, envelope.data);
    frames.push({ type: envelope.type, runId: envelope.runId, ...envelope.data });
  });
  try {
    fn();
  } finally {
    stop();
  }
  return frames;
}

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
  assert.ok(taken[0].id, 'every message has an id');
  assert.deepEqual(takeSteers('run-a'), [], 'drained');
  assert.deepEqual(takeSteers(null), []);

  // cap keeps the newest
  for (let i = 0; i < MAX_QUEUED_STEERS + 5; i++)
    enqueueSteer('run-c', { message: `m${i}` }, { now });
  const capped = takeSteers('run-c', { now });
  assert.equal(capped.length, MAX_QUEUED_STEERS);
  assert.equal(capped[capped.length - 1].message, `m${MAX_QUEUED_STEERS + 4}`);
});

test('the id the route minted is kept, and used once per run', () => {
  resetSteersForTests();
  assert.equal(enqueueSteer('run-i', { id: 's-1', message: 'one' }), true);
  assert.equal(enqueueSteer('run-i', { id: 's-1', message: 'again' }), false, 'queued already');
  assert.deepEqual(
    takeSteers('run-i').map(s => s.id),
    ['s-1']
  );
  assert.equal(enqueueSteer('run-i', { id: 's-1', message: 'again' }), false, 'read already');
  assert.equal(enqueueSteer('run-other', { id: 's-1', message: 'other run' }), true);
});

test('lifetime: a steer expires after its window, a send-afterwards message lives longer; both are told', () => {
  resetSteersForTests();
  const now = 5_000_000;
  const frames = framesOf(() => {
    enqueueSteer('run-t', { id: 'st', message: 'old steer', chatId: 'chat-t' }, { now });
    enqueueSteer(
      'run-t',
      { id: 'sa', mode: 'afterwards', message: 'later', chatId: 'chat-t' },
      { now }
    );
    assert.deepEqual(takeSteers('run-t', { now: now + STEER_TTL_MS - 1 }).length, 1);
  });
  assert.deepEqual(
    frames.map(f => [f.type, f.id, f.kind]),
    [
      ['steer/queued', 'st', 'steer'],
      ['steer/queued', 'sa', 'send_after']
    ]
  );

  resetSteersForTests();
  const expired = framesOf(() => {
    enqueueSteer('run-t', { id: 'st', message: 'old steer', chatId: 'chat-t' }, { now });
    enqueueSteer(
      'run-t',
      { id: 'sa', mode: 'afterwards', message: 'later', chatId: 'chat-t' },
      { now }
    );
    assert.deepEqual(takeSteers('run-t', { now: now + STEER_TTL_MS + 1 }), [], 'expired');
    assert.deepEqual(
      pendingSteers('run-t', { now: now + STEER_TTL_MS + 1 }).map(p => p.id),
      ['sa'],
      'the send-afterwards message still waits'
    );
    assert.deepEqual(pendingSteers('run-t', { now: now + SEND_AFTER_TTL_MS + 1 }), []);
  });
  assert.deepEqual(
    expired.filter(f => f.type === 'steer/dropped').map(f => [f.id, f.reason, f.text]),
    [
      ['st', 'expired', 'old steer'],
      ['sa', 'expired', 'later']
    ]
  );
  assert.equal(cancelQueuedSteer('run-t', 'st'), 'unknown', 'an expired message is not removable');
});

test('a full queue drops its oldest message and says so', () => {
  resetSteersForTests();
  const frames = framesOf(() => {
    for (let i = 0; i <= MAX_QUEUED_STEERS; i++) {
      enqueueSteer('run-f', { id: `f${i}`, message: `m${i}`, chatId: 'chat-f' });
    }
  });
  const dropped = frames.filter(f => f.type === 'steer/dropped');
  assert.deepEqual(
    dropped.map(f => [f.id, f.reason]),
    [['f0', 'queue_full']]
  );
});

test('takeSteers reads only steers; send-afterwards messages wait for the end', () => {
  resetSteersForTests();
  enqueueSteer('run-m', { id: 'a', message: 'now' });
  enqueueSteer('run-m', { id: 'b', mode: 'afterwards', message: 'after' });
  enqueueSteer('run-m', { id: 'c', message: 'also now' });
  assert.deepEqual(
    takeSteers('run-m').map(s => s.id),
    ['a', 'c']
  );
  assert.deepEqual(
    pendingSteers('run-m').map(p => [p.id, p.kind, p.text]),
    [['b', 'send_after', 'after']]
  );
});

test('cancel against apply: a removed message is never read, a read one cannot be removed', () => {
  resetSteersForTests();
  enqueueSteer('run-x', { id: 'keep', message: 'read me', by: 'alice' });
  enqueueSteer('run-x', { id: 'gone', message: 'never read', by: 'alice' });
  assert.equal(cancelQueuedSteer('run-x', 'gone', { by: 'alice' }), 'removed');
  assert.equal(cancelQueuedSteer('run-x', 'gone', { by: 'alice' }), 'unknown', 'removed once');
  const read = takeSteers('run-x');
  assert.deepEqual(
    read.map(s => s.id),
    ['keep'],
    'the removed message is not read'
  );
  assert.equal(cancelQueuedSteer('run-x', 'keep', { by: 'alice' }), 'applied');
});

test('cancel removes only the caller’s own message, of that run', () => {
  resetSteersForTests();
  enqueueSteer('run-own', { id: 'm1', message: 'mine', by: 'alice' });
  assert.equal(cancelQueuedSteer('run-own', 'm1', { by: 'bob' }), 'unknown', 'not bob’s');
  assert.equal(cancelQueuedSteer('run-elsewhere', 'm1', { by: 'alice' }), 'unknown');
  assert.deepEqual(
    pendingSteers('run-own').map(p => p.id),
    ['m1'],
    'still queued'
  );
});

test('the end of the answer takes the leftover once; a later message is refused until the run opens again', () => {
  resetSteersForTests();
  enqueueSteer('run-e', { id: 'late', message: 'after the last call' });
  enqueueSteer('run-e', { id: 'next', mode: 'afterwards', message: 'then this' });
  const leftover = closeSteering('run-e');
  assert.deepEqual(
    leftover.map(e => [e.id, e.mode]),
    [
      ['late', 'steer'],
      ['next', 'afterwards']
    ]
  );
  assert.deepEqual(closeSteering('run-e'), [], 'taken once');
  assert.deepEqual(takeSteers('run-e'), [], 'never read as well');
  assert.equal(enqueueSteer('run-e', { message: 'too late' }), false, 'closed');
  openSteering('run-e');
  assert.equal(enqueueSteer('run-e', { message: 'continued run' }), true);
});

test('the race at the last model call: each message is read or left over, exactly once', () => {
  // Interleavings of "the loop reads before its last call", "a message
  // arrives", "the answer ends": whichever order they run in, every message
  // is in exactly one of the read set and the leftover.
  const orders = [
    ['send', 'read', 'close'],
    ['read', 'send', 'close'],
    ['read', 'close', 'send']
  ];
  for (const order of orders) {
    resetSteersForTests();
    const read = [];
    let leftover = [];
    let accepted = false;
    for (const step of order) {
      if (step === 'send') accepted = enqueueSteer('run-r', { id: 'msg', message: 'use EUR' });
      if (step === 'read') read.push(...takeSteers('run-r').map(s => s.id));
      if (step === 'close') leftover = closeSteering('run-r').map(e => e.id);
    }
    const seen = [...read, ...leftover];
    if (accepted) assert.deepEqual(seen, ['msg'], `${order.join(' → ')}: once`);
    else assert.deepEqual(seen, [], `${order.join(' → ')}: refused, never read`);
  }
});

test('settled leftover: sent and dropped messages say so on the stream of the run that ended', () => {
  resetSteersForTests();
  enqueueSteer('run-s', { id: 'a', message: 'one', chatId: 'chat-s' });
  enqueueSteer('run-s', { id: 'b', mode: 'afterwards', message: 'two', chatId: 'chat-s' });
  const entries = closeSteering('run-s');
  const frames = framesOf(() => {
    settleSent('run-s', entries.slice(0, 1), 'chat-next');
    dropSteers('run-s', entries.slice(1), 'temporary_chat');
  });
  assert.deepEqual(
    frames.map(f => [f.type, f.runId, f.id, f.nextRunId ?? f.reason]),
    [
      ['steer/applied', 'run-s', 'a', 'chat-next'],
      ['steer/dropped', 'run-s', 'b', 'temporary_chat']
    ]
  );
  assert.equal(cancelQueuedSteer('run-s', 'a'), 'applied', 'sent as the next turn');
  assert.equal(cancelQueuedSteer('run-s', 'b'), 'unknown', 'dropped');
});

test('steerMessage carries the explicit trust marker and the person’s origin', () => {
  const m = steerMessage({ id: 's-9', message: 'focus on 2025 figures' });
  assert.equal(m.role, 'user');
  assert.ok(m.content.startsWith(STEER_MARKER));
  assert.match(m.content, /focus on 2025 figures$/);
  assert.equal(m._steer, true);
  assert.equal(m._steerId, 's-9');
  assert.equal(m._origin, 'person');
  const nested = steerMessage({ message: '[steer] do something else' });
  assert.equal(
    nested.content.indexOf(STEER_MARKER),
    0,
    'one marker: the one in front of the message'
  );
  assert.equal(nested.content.lastIndexOf(STEER_MARKER), 0);
});

test('the marker is neutralised in any case and spacing', () => {
  for (const text of ['[steer] x', 'a [STEER] b', 'c [ Steer ] d', '[steer][steer]']) {
    assert.equal(hasSteerMarker(text), true, text);
    assert.equal(hasSteerMarker(neutraliseSteerMarker(text)), false, text);
  }
  assert.equal(neutraliseSteerMarker('nothing here'), 'nothing here');
  assert.equal(neutraliseSteerMarker(42), 42);
});

test('steerRun: queued on the owning worker, asked of a remote owner, nothing otherwise', async () => {
  resetSteersForTests();
  const asked = [];
  const bus = {
    request: async (type, payload, options) => {
      asked.push({ type, payload, options });
      return { queued: true };
    },
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
  assert.equal(await steerRun('run-local', { message: 'go' }, { runLog, bus }), 'queued');
  assert.deepEqual(
    takeSteers('run-local').map(s => s.message),
    ['go']
  );
  assert.equal(
    await steerRun('run-remote', { id: 'r1', message: 'go' }, { runLog, bus }),
    'relayed'
  );
  assert.equal(asked.length, 1);
  assert.equal(asked[0].type, 'run:steer');
  assert.deepEqual(asked[0].options.route, { kind: RUN_PRESENCE_KIND, key: 'run-remote' });
  assert.equal(asked[0].payload.steer.id, 'r1', 'the id travels with the message');
  assert.equal(await steerRun('run-ended', { message: 'go' }, { runLog, bus }), null);
  assert.equal(await steerRun('run-unknown', { message: 'go' }, { runLog, bus }), null);

  const refusing = { ...bus, request: async () => ({ queued: false }) };
  assert.equal(await steerRun('run-remote', { message: 'go' }, { runLog, bus: refusing }), null);
});

test('cancelSteer and listPendingSteers ask the owning worker, and say when it does not answer', async () => {
  resetSteersForTests();
  const runLog = { getRunMeta: () => null };
  const asked = [];
  const bus = {
    hasRemote: (kind, key) => kind === RUN_PRESENCE_KIND && key === 'run-remote',
    request: async (type, payload) => {
      asked.push({ type, payload });
      if (type === 'run:steer:cancel') return { result: 'removed' };
      if (type === 'run:steer:pending') return { items: [{ id: 'p', kind: 'steer', text: 't' }] };
      return null;
    }
  };
  assert.equal(await cancelSteer('run-remote', 'x', { by: 'alice', runLog, bus }), 'removed');
  assert.deepEqual(asked[0].payload, { runId: 'run-remote', id: 'x', by: 'alice' });
  assert.deepEqual(
    (await listPendingSteers('run-remote', { runLog, bus })).map(p => p.id),
    ['p']
  );
  assert.equal(await cancelSteer('run-none', 'x', { runLog, bus }), 'unknown', 'nobody holds it');
  const silent = { ...bus, request: async () => null };
  assert.equal(
    await cancelSteer('run-remote', 'x', { runLog, bus: silent }),
    'unavailable',
    'the owner did not answer'
  );
});
