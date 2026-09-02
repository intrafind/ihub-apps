// Plain-node test (node server/tests/sse-cluster-helpers.test.js).
//
// The cluster-aware helpers in server/sse.js replaced direct `clients` /
// `activeRequests` lookups across the chat routes. Outside a cluster there is
// no "other worker", so every one of them has to behave exactly like the map
// access it replaced — that equivalence is what this file pins down, since a
// regression here would break single-process installs (WORKERS=1, dev, the
// packaged binary) rather than the clustered ones the bus was written for.
//
// Every frame on the wire is an SSE v2 envelope (`event: <type>` +
// `data: { v: 2, seq, runId, ts, type, data }`), so delivery is driven here
// through `deliverEnvelope` / `routeEnvelope` and a `RunStreamEmitter` — the
// producers that exist after the legacy actionTracker dialect was deleted.

import assert from 'assert';
import {
  activeRequests,
  abortChatRequest,
  clients,
  closeChatClient,
  deliverEnvelope,
  hasActiveChatRequest,
  hasChatClient,
  routeEnvelope,
  sendSSE
} from '../sse.js';
import { buildEnvelope, resetStream, RunStreamEmitter } from '../services/loop/RunStream.js';

let failed = false;
function check(label, fn) {
  try {
    fn();
    console.log(`✅ ${label}`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${label}\n   ${error.message}`);
  }
}

function fakeClient() {
  const writes = [];
  let ended = false;
  return {
    writes,
    isEnded: () => ended,
    entry: {
      lastActivity: new Date(0),
      response: {
        write: chunk => writes.push(chunk),
        end: () => {
          ended = true;
        }
      }
    }
  };
}

/** A valid v2 envelope for `streamId` (explicit seq so the stream counter is untouched). */
function envelopeFor(streamId, { runId = 'chat-run-1', seq = 1, type = 'step/delta' } = {}) {
  return buildEnvelope({
    streamId,
    runId,
    seq,
    type,
    data: type === 'step/delta' ? { step: 1, kind: 'text', content: 'hi' } : {}
  });
}

/** Parse the two-line frame written for one envelope. */
function parseFrame(writes, offset = 0) {
  const eventLine = writes[offset];
  const dataLine = writes[offset + 1];
  assert.ok(eventLine.startsWith('event: '), `event line, got ${JSON.stringify(eventLine)}`);
  assert.ok(dataLine.startsWith('data: '), `data line, got ${JSON.stringify(dataLine)}`);
  assert.ok(dataLine.endsWith('\n\n'), 'data line closes the frame with a blank line');
  return {
    event: eventLine.slice('event: '.length, -1),
    payload: JSON.parse(dataLine.slice('data: '.length, -2))
  };
}

function reset() {
  clients.clear();
  activeRequests.clear();
}

// ---- presence lookups ----

reset();
check('hasChatClient is false with no registration', () =>
  assert.strictEqual(hasChatClient('chat-1'), false)
);

const client = fakeClient();
clients.set('chat-1', client.entry);
check('hasChatClient is true once registered', () =>
  assert.strictEqual(hasChatClient('chat-1'), true)
);
check('hasChatClient refreshes lastActivity without replacing the entry', () => {
  // The SSE GET handler pins its entry by reference to detect a stale close
  // after a reconnect; swapping the object out would defeat that check.
  assert.strictEqual(clients.get('chat-1'), client.entry);
  assert.ok(client.entry.lastActivity.getTime() > 0);
});

check('hasActiveChatRequest is false before an LLM call starts', () =>
  assert.strictEqual(hasActiveChatRequest('chat-1'), false)
);
activeRequests.set('chat-1', new AbortController());
check('hasActiveChatRequest is true while a call is in flight', () =>
  assert.strictEqual(hasActiveChatRequest('chat-1'), true)
);

// ---- sendSSE (the frame writer) ----

check(
  'sendSSE writes `event:` and `data:` lines, JSON-encoding objects and passing strings through',
  () => {
    const raw = fakeClient();
    sendSSE(raw.entry.response, 'meta', { a: 1 });
    sendSSE(raw.entry.response, 'meta', '{"already":"json"}');
    assert.deepStrictEqual(raw.writes, [
      'event: meta\n',
      'data: {"a":1}\n\n',
      'event: meta\n',
      'data: {"already":"json"}\n\n'
    ]);
  }
);

// ---- delivery ----

reset();
const target = fakeClient();
clients.set('chat-3', target.entry);
check(
  'deliverEnvelope writes `event: <type>` + `data: <envelope>` to the local client, stamping the stream seq',
  () => {
    resetStream('chat-3');
    const envelope = envelopeFor('chat-3', { seq: 7 });
    assert.strictEqual(deliverEnvelope('chat-3', envelope), true);
    assert.strictEqual(target.writes.length, 2);
    const { event, payload } = parseFrame(target.writes);
    assert.strictEqual(event, 'step/delta');
    assert.deepStrictEqual(payload, { ...envelope, seq: 1 });
    assert.strictEqual(payload.v, 2);
    assert.strictEqual(payload.seq, 1, 'the delivering worker owns the sequence');
    assert.strictEqual(envelope.seq, 7, 'the caller envelope is not mutated');
    assert.strictEqual(payload.runId, 'chat-run-1', 'runId is the run, not the stream');
    assert.deepStrictEqual(payload.data, { step: 1, kind: 'text', content: 'hi' });
  }
);
check('deliverEnvelope refreshes lastActivity on the entry it wrote to', () => {
  assert.ok(target.entry.lastActivity.getTime() > 0);
  assert.strictEqual(clients.get('chat-3'), target.entry);
});
check('deliverEnvelope reports false for an unknown stream', () =>
  assert.strictEqual(deliverEnvelope('nope', envelopeFor('nope')), false)
);
check('deliverEnvelope reports false without a streamId or an envelope', () => {
  assert.strictEqual(deliverEnvelope(undefined, envelopeFor('chat-3')), false);
  assert.strictEqual(deliverEnvelope('chat-3', null), false);
  assert.strictEqual(target.writes.length, 2, 'nothing extra written');
});

check('routeEnvelope delivers locally when this worker holds the stream', () => {
  const before = target.writes.length;
  assert.strictEqual(routeEnvelope('chat-3', envelopeFor('chat-3', { seq: 8 })), true);
  assert.strictEqual(target.writes.length, before + 2);
  assert.strictEqual(parseFrame(target.writes, before).payload.seq, 2, 'stream counter continues');
});
check(
  'routeEnvelope reports false for an unknown stream outside a cluster (nobody to relay to)',
  () => assert.strictEqual(routeEnvelope('nope', envelopeFor('nope')), false)
);

check(
  'a RunStreamEmitter on the stream reaches the local client through the installed delivery',
  () => {
    // server/sse.js installs routeEnvelope as the RunStream delivery at import;
    // every producer in the process therefore lands here without knowing about it.
    resetStream('chat-3');
    const before = target.writes.length;
    const emitter = new RunStreamEmitter({ streamId: 'chat-3', runId: 'chat-run-9' });
    const first = emitter.emit('run/started', { kind: 'chat', refs: { chatId: 'chat-3' } });
    const second = emitter.emit('step/delta', { step: 1, kind: 'text', content: 'via emitter' });
    assert.strictEqual(target.writes.length, before + 4);
    const a = parseFrame(target.writes, before);
    const b = parseFrame(target.writes, before + 2);
    assert.strictEqual(a.event, 'run/started');
    assert.deepStrictEqual(a.payload, { ...first, seq: 1 });
    assert.strictEqual(b.event, 'step/delta');
    assert.deepStrictEqual(b.payload, { ...second, seq: 2 });
    assert.strictEqual(a.payload.runId, 'chat-run-9');
    assert.strictEqual(a.payload.seq, 1, 'fresh stream counter starts at 1');
    assert.strictEqual(b.payload.seq, 2, 'seq climbs per stream');
    resetStream('chat-3');
  }
);

// A dead socket must tear its own registration down, or the LLM keeps streaming
// into a void and the AbortController leaks until the 5-minute sweep.
reset();
const controller = new AbortController();
clients.set('chat-4', {
  lastActivity: new Date(),
  response: {
    write() {
      throw new Error('EPIPE');
    }
  }
});
activeRequests.set('chat-4', controller);
check('a failed write tears down the client and aborts + deletes its request controller', () => {
  assert.strictEqual(deliverEnvelope('chat-4', envelopeFor('chat-4')), false);
  assert.strictEqual(clients.has('chat-4'), false);
  assert.strictEqual(activeRequests.has('chat-4'), false);
  assert.strictEqual(controller.signal.aborted, true);
});

reset();
clients.set('chat-4b', {
  lastActivity: new Date(),
  response: {
    write() {
      throw new Error('EPIPE');
    }
  }
});
check(
  'a failed write without an in-flight request still drops the client and does not throw',
  () => {
    assert.strictEqual(deliverEnvelope('chat-4b', envelopeFor('chat-4b')), false);
    assert.strictEqual(clients.has('chat-4b'), false);
  }
);

// A browser that reconnected while the old socket was dying registers a fresh
// entry under the same streamId; tearing down the dead one must not evict it.
reset();
const reconnected = fakeClient();
clients.set('chat-4c', {
  lastActivity: new Date(),
  response: {
    write() {
      clients.set('chat-4c', reconnected.entry);
      throw new Error('write after end');
    }
  }
});
check('a failed write never evicts an entry that reconnected in the meantime', () => {
  assert.strictEqual(deliverEnvelope('chat-4c', envelopeFor('chat-4c')), false);
  assert.strictEqual(clients.get('chat-4c'), reconnected.entry);
  assert.strictEqual(deliverEnvelope('chat-4c', envelopeFor('chat-4c', { seq: 2 })), true);
  assert.strictEqual(reconnected.writes.length, 2);
});

// ---- abort ----

reset();
check('abortChatRequest reports false when nothing is in flight', () =>
  assert.strictEqual(abortChatRequest('chat-5'), false)
);

const liveController = new AbortController();
activeRequests.set('chat-5', liveController);
check('abortChatRequest aborts and clears the local controller', () => {
  assert.strictEqual(abortChatRequest('chat-5'), true);
  assert.strictEqual(liveController.signal.aborted, true);
  assert.strictEqual(activeRequests.has('chat-5'), false);
  assert.strictEqual(hasActiveChatRequest('chat-5'), false);
});

// ---- close ----

reset();
check('closeChatClient reports false when no stream exists', () =>
  assert.strictEqual(closeChatClient('chat-6'), false)
);

const closing = fakeClient();
clients.set('chat-6', closing.entry);
check('closeChatClient ends the response and drops the entry', () => {
  assert.strictEqual(closeChatClient('chat-6'), true);
  assert.strictEqual(closing.isEnded(), true);
  assert.strictEqual(clients.has('chat-6'), false);
  assert.strictEqual(hasChatClient('chat-6'), false);
  assert.strictEqual(deliverEnvelope('chat-6', envelopeFor('chat-6')), false);
});

// An already-destroyed socket throws on end(); tearing down must still finish,
// because an unguarded throw here surfaces as an unhandled rejection.
reset();
clients.set('chat-7', {
  lastActivity: new Date(),
  response: {
    end() {
      throw new Error('write after end');
    }
  }
});
check('closeChatClient survives a socket that throws on end()', () => {
  assert.strictEqual(closeChatClient('chat-7'), true);
  assert.strictEqual(clients.has('chat-7'), false);
});

reset();

if (failed) {
  console.error('\nsse cluster helpers: FAILED');
  process.exit(1);
}
console.log('\nsse cluster helpers: all checks passed');
