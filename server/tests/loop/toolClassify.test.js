/**
 * Tool result classification + segment planner specs (circuit breaker input
 * and parallelism rules).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolResult } from '../../services/loop/toolClassify.js';
import { planToolBatches } from '../../services/loop/segmentPlanner.js';
import { drainToolResponse } from '../../services/loop/seams/passthroughSeam.js';

const msg = content => ({ role: 'tool', content });

test('classifyToolResult: plain output is never an error', () => {
  assert.deepEqual(classifyToolResult(msg('just text')), {
    failed: false,
    rateLimited: false,
    message: ''
  });
  assert.equal(classifyToolResult(msg(JSON.stringify({ results: [] }))).failed, false);
  assert.equal(classifyToolResult(null).failed, false);
});

test('classifyToolResult: { error, message } shape — rate limit by message text', () => {
  const plain = classifyToolResult(msg(JSON.stringify({ error: true, message: 'boom' })));
  assert.deepEqual(plain, { failed: true, rateLimited: false, message: 'boom' });
  const limited = classifyToolResult(
    msg(JSON.stringify({ error: true, message: 'Too Many Requests (429)' }))
  );
  assert.equal(limited.rateLimited, true);
});

test('classifyToolResult: { error, status, statusText, body } shape — rate limit by status', () => {
  const r429 = classifyToolResult(
    msg(
      JSON.stringify({
        error: 'HTTP error',
        status: 429,
        statusText: 'Too Many Requests',
        body: ''
      })
    )
  );
  assert.equal(r429.failed, true);
  assert.equal(r429.rateLimited, true);
  assert.equal(r429.message, 'HTTP error');

  const r503 = classifyToolResult(
    msg({ error: true, status: 503, statusText: 'Service Unavailable' })
  );
  assert.equal(r503.rateLimited, true);
  assert.equal(r503.message, 'Service Unavailable');

  const r500 = classifyToolResult(
    msg({ error: true, status: 500, statusText: 'Internal Server Error' })
  );
  assert.equal(r500.failed, true);
  assert.equal(r500.rateLimited, false);

  const byCode = classifyToolResult(msg({ error: true, code: 'RATE_LIMITED' }));
  assert.equal(byCode.rateLimited, true);
});

test('segment planner: a mutable call with no inferable target never shares a batch', () => {
  const positions = batches => batches.map(b => b.map(i => i.position));
  assert.deepEqual(
    positions(
      planToolBatches([
        { call: {}, toolDef: { id: 'w' }, args: {} },
        { call: {}, toolDef: { id: 'w' }, args: { path: 'a' } },
        { call: {}, toolDef: { id: 'w' }, args: { path: 'b' } },
        { call: {}, toolDef: { id: 'w' }, args: {} }
      ])
    ),
    [[0], [1, 2], [3]]
  );
  // read-only calls with unknown targets still run together, but not next to a write
  assert.deepEqual(
    positions(
      planToolBatches([
        { call: {}, toolDef: { id: 'r', readOnly: true }, args: {} },
        { call: {}, toolDef: { id: 'r', readOnly: true }, args: {} },
        { call: {}, toolDef: { id: 'w' }, args: { path: 'x' } }
      ])
    ),
    [[0, 1], [2]]
  );
  // a write with a known target may join a read-only call with a known, disjoint target
  assert.deepEqual(
    positions(
      planToolBatches([
        { call: {}, toolDef: { id: 'r', readOnly: true }, args: { q: 'a' } },
        { call: {}, toolDef: { id: 'w' }, args: { path: 'b' } }
      ])
    ),
    [[0, 1]]
  );
});

test('passthrough collection is bounded while the stream keeps flowing', async () => {
  async function* chunks() {
    for (let i = 0; i < 5; i++) yield 'abcd';
  }
  const emitted = [];
  const text = await drainToolResponse(chunks(), c => emitted.push(c), { limit: 10 });
  assert.equal(emitted.join(''), 'abcd'.repeat(5), 'every chunk still reaches the client');
  assert.ok(text.startsWith('abcdabcdab'), 'collected text is cut at the limit');
  assert.match(text, /output truncated/);
  assert.ok(text.length < 'abcd'.repeat(5).length + 200);

  const small = await drainToolResponse('short', () => {}, { limit: 10 });
  assert.equal(small, 'short');
});
