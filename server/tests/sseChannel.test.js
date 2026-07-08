// Plain-node test (node server/tests/sseChannel.test.js).
//
// createSseChannel/sweepInactiveClients consolidate the SSE connection
// lifecycle (headers, pinned Map entry, heartbeat, close teardown, dead-client
// sweep) that used to be hand-rolled with copy-pasted comments in
// sessionRoutes.js, runs.js and workflowRoutes.js (issue #1811).
import assert from 'assert';
import { createSseChannel, sweepInactiveClients } from '../utils/sseChannel.js';

function fakeReqRes() {
  const headers = {};
  const writes = [];
  let closeHandler = null;
  const req = {
    on(event, cb) {
      if (event === 'close') closeHandler = cb;
    }
  };
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
    write(chunk) {
      writes.push(chunk);
    }
  };
  return {
    req,
    res,
    headers,
    writes,
    triggerClose: () => closeHandler?.()
  };
}

// Every test below must trigger close on every channel it opens — the
// heartbeat setInterval is otherwise a live handle that keeps the process
// (and this Jest run) from exiting.

// ---- headers ----
{
  const helper = fakeReqRes();
  const map = new Map();
  createSseChannel({ req: helper.req, res: helper.res, id: 'a', map, component: 'Test' });
  assert.strictEqual(helper.headers['Content-Type'], 'text/event-stream');
  assert.strictEqual(helper.headers['Cache-Control'], 'no-cache');
  assert.strictEqual(helper.headers['Connection'], 'keep-alive');
  assert.strictEqual(helper.headers['X-Accel-Buffering'], 'no');
  assert.ok(map.has('a'), 'registers itself in the map');
  helper.triggerClose();
}
console.log('✅ createSseChannel sets standard SSE headers and registers in the map');

// ---- send() formats events and bumps lastActivity ----
{
  const helper = fakeReqRes();
  const map = new Map();
  const channel = createSseChannel({
    req: helper.req,
    res: helper.res,
    id: 'a',
    map,
    component: 'Test'
  });
  const before = map.get('a').lastActivity;
  const ok = channel.send('token', { content: 'hi' });
  assert.strictEqual(ok, true);
  assert.strictEqual(helper.writes[0], 'event: token\ndata: {"content":"hi"}\n\n');
  assert.ok(map.get('a').lastActivity >= before);
  helper.triggerClose();
}
console.log('✅ channel.send() writes a well-formed SSE event and refreshes lastActivity');

// ---- pinned entry: a stale connection can't clobber a fresh reconnect ----
{
  const map = new Map();
  let firstOnCloseArg = null;
  const first = fakeReqRes();
  const firstChannel = createSseChannel({
    req: first.req,
    res: first.res,
    id: 'chat-1',
    map,
    component: 'Test',
    onClose: arg => {
      firstOnCloseArg = arg;
    }
  });
  const firstEntry = map.get('chat-1');

  // Simulate a reconnect on the same id before the first connection's close
  // handler has fired — this is the scenario the "pinned entry" comment in
  // the original sessionRoutes.js/workflowRoutes.js code protects against.
  const second = fakeReqRes();
  let secondOnCloseArg = null;
  createSseChannel({
    req: second.req,
    res: second.res,
    id: 'chat-1',
    map,
    component: 'Test',
    onClose: arg => {
      secondOnCloseArg = arg;
    }
  });
  const secondEntry = map.get('chat-1');
  assert.notStrictEqual(secondEntry, firstEntry, 'second connection replaces the entry');

  // The stale first connection's own close fires after the reconnect — it
  // must not delete the second connection's live entry.
  first.triggerClose();
  assert.strictEqual(map.get('chat-1'), secondEntry, 'stale close does not delete the live entry');
  assert.strictEqual(firstOnCloseArg.isCurrent, false);
  assert.strictEqual(firstChannel.isCurrent(), false);

  // Closing the still-current second connection does remove the entry.
  second.triggerClose();
  assert.strictEqual(map.has('chat-1'), false);
  assert.strictEqual(secondOnCloseArg.isCurrent, true);
}
console.log("✅ a stale close handler cannot delete a fresher reconnect's entry");

// ---- close teardown: current connection removes itself and reports isCurrent ----
{
  const helper = fakeReqRes();
  const map = new Map();
  let onCloseArg = null;
  createSseChannel({
    req: helper.req,
    res: helper.res,
    id: 'a',
    map,
    component: 'Test',
    onClose: arg => {
      onCloseArg = arg;
    }
  });
  assert.ok(map.has('a'));
  helper.triggerClose();
  assert.strictEqual(map.has('a'), false, 'current connection removes its own entry on close');
  assert.strictEqual(onCloseArg.isCurrent, true);
}
console.log('✅ close teardown deletes the map entry and reports isCurrent: true');

// ---- heartbeat keeps writing on a live socket ----
{
  const helper = fakeReqRes();
  const map = new Map();
  createSseChannel({
    req: helper.req,
    res: helper.res,
    id: 'a',
    map,
    component: 'Test',
    heartbeatMs: 5
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(
    helper.writes.some(w => w === ': heartbeat\n\n'),
    'heartbeat comment was written'
  );
  assert.ok(map.has('a'), 'live connection stays registered across heartbeats');
  helper.triggerClose();
}
console.log('✅ heartbeat writes SSE comments on a live connection');

// ---- heartbeat self-evicts on a dead socket ----
{
  const helper = fakeReqRes();
  helper.res.write = () => {
    throw new Error('socket hang up');
  };
  const map = new Map();
  createSseChannel({
    req: helper.req,
    res: helper.res,
    id: 'a',
    map,
    component: 'Test',
    heartbeatMs: 5
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(map.has('a'), false, 'dead socket is evicted by the heartbeat');
}
console.log('✅ heartbeat evicts the map entry when the write fails');

// ---- sweepInactiveClients ----
{
  const map = new Map();
  const stale = fakeReqRes();
  let ended = false;
  stale.res.end = () => {
    ended = true;
  };
  map.set('old', { response: stale.res, lastActivity: new Date(Date.now() - 10 * 60 * 1000) });

  const fresh = fakeReqRes();
  map.set('fresh', { response: fresh.res, lastActivity: new Date() });

  const evicted = [];
  sweepInactiveClients(map, {
    timeoutMs: 5 * 60 * 1000,
    component: 'Test',
    onEvict: id => evicted.push(id)
  });

  assert.strictEqual(map.has('old'), false, 'stale entry evicted');
  assert.strictEqual(map.has('fresh'), true, 'recently active entry kept');
  assert.strictEqual(ended, true, 'evicted client response is ended');
  assert.deepStrictEqual(evicted, ['old']);
}
console.log('✅ sweepInactiveClients evicts only entries past the timeout and calls onEvict');
