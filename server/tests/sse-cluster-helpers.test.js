// Plain-node test (node server/tests/sse-cluster-helpers.test.js).
//
// The cluster-aware helpers in server/sse.js replaced direct `clients` /
// `activeRequests` lookups across the chat routes. Outside a cluster there is
// no "other worker", so every one of them has to behave exactly like the map
// access it replaced — that equivalence is what this file pins down, since a
// regression here would break single-process installs (WORKERS=1, dev, the
// packaged binary) rather than the clustered ones the bus was written for.

import assert from 'assert';
import { actionTracker } from '../actionTracker.js';
import {
  activeRequests,
  abortChatRequest,
  clients,
  closeChatClient,
  deliverSSEEvent,
  getChatResponseSink,
  hasActiveChatRequest,
  hasChatClient
} from '../sse.js';

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

check('hasActiveChatRequest is false before an LLM call starts', () =>
  assert.strictEqual(hasActiveChatRequest('chat-1'), false)
);
activeRequests.set('chat-1', new AbortController());
check('hasActiveChatRequest is true while a call is in flight', () =>
  assert.strictEqual(hasActiveChatRequest('chat-1'), true)
);

// ---- sink resolution ----

reset();
check('getChatResponseSink returns null with no stream', () =>
  assert.strictEqual(getChatResponseSink('chat-2'), null)
);

const sinkClient = fakeClient();
clients.set('chat-2', sinkClient.entry);
const sink = getChatResponseSink('chat-2');
check('getChatResponseSink returns the local response object', () =>
  assert.strictEqual(sink, sinkClient.entry.response)
);
check('resolving the sink refreshes lastActivity without replacing the entry', () => {
  // The SSE GET handler pins its entry by reference to detect a stale close
  // after a reconnect; swapping the object out would defeat that check.
  assert.strictEqual(clients.get('chat-2'), sinkClient.entry);
  assert.ok(sinkClient.entry.lastActivity.getTime() > 0);
});

// ---- delivery ----

reset();
const target = fakeClient();
clients.set('chat-3', target.entry);
check('deliverSSEEvent writes an SSE frame to the local client', () => {
  assert.strictEqual(deliverSSEEvent({ chatId: 'chat-3', event: 'chunk', content: 'hi' }), true);
  assert.strictEqual(target.writes[0], 'event: chunk\n');
  assert.ok(target.writes[1].startsWith('data: {'));
});
check('deliverSSEEvent reports false for an unknown chat', () =>
  assert.strictEqual(deliverSSEEvent({ chatId: 'nope', event: 'chunk' }), false)
);

check('actionTracker events still reach the local client', () => {
  const before = target.writes.length;
  actionTracker.trackChunk('chat-3', { content: 'via tracker' });
  assert.ok(target.writes.length > before);
});

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
check('a failed write tears down the client and aborts its request', () => {
  assert.strictEqual(deliverSSEEvent({ chatId: 'chat-4', event: 'chunk' }), false);
  assert.strictEqual(clients.has('chat-4'), false);
  assert.strictEqual(activeRequests.has('chat-4'), false);
  assert.strictEqual(controller.signal.aborted, true);
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
