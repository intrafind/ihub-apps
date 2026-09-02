/**
 * RunStream specs — the SSE v2 producer side (`services/loop/RunStream.js`).
 *
 * Pins: the per-stream monotonic `seq` (shared by every emitter on a stream),
 * envelope shape and validation (`buildEnvelope`), the drop-and-log contract
 * for invalid payloads and failing delivery (`RunStreamEmitter.emit`), the
 * stream → run binding used by tool progress (`bindStreamRun`, `getStreamRun`,
 * `streamEmitter`, `emitToolProgress`), the workflow checkpoint → interaction
 * mapping (`checkpointToInteraction`), the internal bus → v2 translation for
 * every event DESIGN-C4 lists (`translateInternalEvent`) and the ledger → v2
 * re-sync projection (`projectLedgerEvent`).
 *
 * Every produced payload is checked against the v2 contract
 * (`parseSseV2EventData` / `sseV2EventSchema`), so a contract change that the
 * producer does not follow fails here before it reaches a client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RunStreamEmitter,
  buildEnvelope,
  setEnvelopeDelivery,
  nextSeq,
  currentSeq,
  resetStream,
  bindStreamRun,
  unbindStreamRun,
  getStreamRun,
  streamEmitter,
  emitToolProgress,
  checkpointToInteraction,
  translateInternalEvent,
  projectLedgerEvent
} from '../../services/loop/RunStream.js';
import { sseV2EventSchema, parseSseV2EventData } from '../../services/loop/contracts/sseV2.js';
import { interactionSchema } from '../../services/loop/contracts/interaction.js';
import { SSE_V2_EVENTS, RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { routeEnvelope } from '../../sse.js';
import logger from '../../utils/logger.js';

const {
  STREAM_CONNECTED,
  STREAM_ERROR,
  RUN_STARTED,
  RUN_ENDED,
  RUN_PAUSED,
  RUN_RESUMED,
  STEP_DELTA,
  STEP_COMPLETED,
  TOOL_STARTED,
  TOOL_PROGRESS,
  TOOL_COMPLETED,
  INTERACTION_RAISED,
  INTERACTION_ANSWERED,
  PROGRESS_NODE,
  META
} = SSE_V2_EVENTS;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minimal call-recording spy: `fn.calls` is the list of argument arrays. */
function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

let streamCounter = 0;
/** A stream id nobody else in the process uses; its counter is reset after the test. */
function freshStream(t, label = 'stream') {
  const id = `runstream-test-${label}-${++streamCounter}`;
  resetStream(id);
  t.after(() => resetStream(id));
  return id;
}

/** Replace a logger method for the duration of the test. */
function spyLogger(t, method) {
  const original = logger[method];
  const fn = spy();
  logger[method] = fn;
  t.after(() => {
    logger[method] = original;
  });
  return fn;
}

/** Install a recording delivery function for the test; restored to sse.js's router after. */
function spyDelivery(t) {
  const fn = spy();
  setEnvelopeDelivery(fn);
  t.after(() => setEnvelopeDelivery(routeEnvelope));
  return fn;
}

function assertValidEnvelope(envelope) {
  const verdict = sseV2EventSchema.safeParse(envelope);
  assert.ok(
    verdict.success,
    `invalid v2 envelope ${envelope?.type}: ${JSON.stringify(verdict.error?.issues)}`
  );
}

/** Wrap `translateInternalEvent` triples in envelopes and validate every one. */
function translated(eventData, streamId = 'wf-stream') {
  const triples = translateInternalEvent(eventData);
  for (const { type, data } of triples) {
    assert.doesNotThrow(
      () => parseSseV2EventData(type, data),
      `payload for ${type} must satisfy its contract`
    );
    assertValidEnvelope(buildEnvelope({ streamId, runId: eventData.executionId, type, data }));
  }
  return triples;
}

// ── seq bookkeeping ─────────────────────────────────────────────────────────

test('nextSeq / currentSeq / resetStream: a per-stream counter starting at 1', t => {
  const s = freshStream(t, 'seq');
  assert.equal(currentSeq(s), 0);
  assert.equal(nextSeq(s), 1);
  assert.equal(nextSeq(s), 2);
  assert.equal(currentSeq(s), 2);
  const other = freshStream(t, 'seq-other');
  assert.equal(nextSeq(other), 1, 'streams do not share a counter');
  assert.equal(currentSeq(s), 2);
  resetStream(s);
  assert.equal(currentSeq(s), 0);
  assert.equal(nextSeq(s), 1, 'a reset stream starts over');
});

test('seq is monotonic per stream across two emitters (two runs) on the same stream', t => {
  const s = freshStream(t, 'two-emitters');
  const delivered = [];
  const deliver = (streamId, envelope) => delivered.push({ streamId, envelope });
  const a = new RunStreamEmitter({ streamId: s, runId: 'chat-run-a', deliver });
  const b = new RunStreamEmitter({ streamId: s, runId: 'chat-run-b', deliver });

  const e1 = a.emit(RUN_STARTED, { kind: 'chat' });
  const e2 = b.emit(RUN_STARTED, { kind: 'chat' });
  const e3 = a.emit(STEP_DELTA, { step: 1, kind: 'text', content: 'a' });
  const e4 = b.emit(STEP_DELTA, { step: 1, kind: 'text', content: 'b' });
  const e5 = a.emit(RUN_ENDED, { status: 'completed' });
  const e6 = b.emit(RUN_ENDED, { status: 'completed' });

  assert.deepEqual(
    [e1, e2, e3, e4, e5, e6].map(e => e.seq),
    [1, 2, 3, 4, 5, 6]
  );
  assert.deepEqual(
    [e1, e2, e3, e4, e5, e6].map(e => e.runId),
    ['chat-run-a', 'chat-run-b', 'chat-run-a', 'chat-run-b', 'chat-run-a', 'chat-run-b']
  );
  assert.equal(currentSeq(s), 6);
  assert.deepEqual(
    delivered.map(d => d.streamId),
    Array(6).fill(s)
  );
  assert.deepEqual(
    delivered.map(d => d.envelope),
    [e1, e2, e3, e4, e5, e6],
    'delivery receives the same envelope emit returns'
  );
  for (const envelope of delivered.map(d => d.envelope)) assertValidEnvelope(envelope);

  const elsewhere = freshStream(t, 'elsewhere');
  const c = new RunStreamEmitter({ streamId: elsewhere, deliver });
  assert.equal(c.emit(RUN_STARTED, { kind: 'agent' }).seq, 1, 'another stream starts at 1');
});

// ── buildEnvelope ───────────────────────────────────────────────────────────

test('buildEnvelope: shape { v:2, seq, runId, ts, type, data } with contract defaults applied', t => {
  const s = freshStream(t, 'build');
  const before = Date.now();
  const envelope = buildEnvelope({
    streamId: s,
    runId: 'chat-run-1',
    type: RUN_STARTED,
    data: { kind: 'chat' }
  });
  assertValidEnvelope(envelope);
  assert.deepEqual(Object.keys(envelope).sort(), ['data', 'runId', 'seq', 'ts', 'type', 'v']);
  assert.equal(envelope.v, 2);
  assert.equal(envelope.seq, 1);
  assert.equal(envelope.runId, 'chat-run-1');
  assert.equal(envelope.type, RUN_STARTED);
  assert.deepEqual(envelope.data, { kind: 'chat', refs: {} }, 'schema defaults (refs) applied');
  assert.match(envelope.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(envelope.ts) >= before - 1000);

  const next = buildEnvelope({ streamId: s, type: STREAM_CONNECTED, data: undefined });
  assert.equal(next.seq, 2, 'seq comes from the stream counter');
  assert.equal(next.runId, s, 'runId falls back to the stream id');
  assert.deepEqual(next.data, { lastSeq: 0, protocol: 2 }, 'missing data → {} → defaults');

  const explicit = buildEnvelope({
    streamId: s,
    runId: 'chat-run-1',
    type: META,
    data: { title: 'T' },
    seq: 42
  });
  assert.equal(explicit.seq, 42, 'an explicit seq is honoured');
  assert.equal(currentSeq(s), 2, '…and does not touch the stream counter');
});

test('buildEnvelope: an invalid payload or unknown type throws (producer bug, never swallowed here)', t => {
  const s = freshStream(t, 'build-invalid');
  assert.throws(
    () => buildEnvelope({ streamId: s, type: STEP_DELTA, data: { step: 'one', kind: 'text' } }),
    err => err.name === 'ZodError'
  );
  assert.throws(
    () => buildEnvelope({ streamId: s, type: RUN_ENDED, data: { status: 'nope' } }),
    err => err.name === 'ZodError'
  );
  assert.throws(() => buildEnvelope({ streamId: s, type: 'legacy/chunk', data: {} }), {
    message: /Unknown SSE v2 event type: legacy\/chunk/
  });
  assert.equal(currentSeq(s), 0, 'validation runs before the seq is consumed');
});

// ── RunStreamEmitter.emit ───────────────────────────────────────────────────

test('emit: builds, delivers and returns the envelope; runId comes from opts, then the binding, then the stream', t => {
  const s = freshStream(t, 'emit');
  const deliver = spy();
  const unbound = new RunStreamEmitter({ streamId: s, deliver });
  const e1 = unbound.emit(RUN_STARTED, { kind: 'chat' });
  assert.equal(e1.runId, s, 'no run bound → stream id');

  assert.equal(unbound.bind('chat-run-x'), unbound, 'bind() is chainable');
  const e2 = unbound.emit(STEP_DELTA, { step: 1, kind: 'text', content: 'x' });
  assert.equal(e2.runId, 'chat-run-x');

  const e3 = unbound.emit(META, { title: 'hello' }, { runId: 'chat-run-override' });
  assert.equal(e3.runId, 'chat-run-override', 'per-envelope override wins');
  assert.equal(unbound.runId, 'chat-run-x', 'the override is not sticky');

  assert.deepEqual(
    deliver.calls.map(([streamId, envelope]) => [streamId, envelope.seq]),
    [
      [s, 1],
      [s, 2],
      [s, 3]
    ]
  );
  assert.equal(deliver.calls[2][1], e3, 'delivery gets the very object emit returns');
  for (const [, envelope] of deliver.calls) assertValidEnvelope(envelope);
});

test('emit: an invalid payload is dropped — returns null, nothing delivered, logged as an error, seq untouched', t => {
  const s = freshStream(t, 'emit-invalid');
  const deliver = spy();
  const error = spyLogger(t, 'error');
  const emitter = new RunStreamEmitter({ streamId: s, runId: 'chat-run-1', deliver });

  let result;
  assert.doesNotThrow(() => {
    result = emitter.emit(TOOL_STARTED, { step: 1, callId: 'c1' /* toolId, name missing */ });
  });
  assert.equal(result, null);
  assert.equal(deliver.calls.length, 0);
  assert.equal(error.calls.length, 1);
  const [message, meta] = error.calls[0];
  assert.match(message, /Invalid SSE v2 payload/);
  assert.equal(meta.component, 'RunStream');
  assert.equal(meta.streamId, s);
  assert.equal(meta.type, TOOL_STARTED);
  assert.equal(typeof meta.error, 'string');
  assert.equal(currentSeq(s), 0, 'a dropped frame does not create a seq gap');

  assert.equal(emitter.emit('not/a/type', {}), null, 'unknown type is dropped the same way');
  assert.equal(error.calls.length, 2);

  const ok = emitter.emit(STEP_DELTA, { step: 1, kind: 'text', content: 'still works' });
  assert.equal(ok.seq, 1, 'the emitter keeps working after a drop');
});

test('emit: a throwing delivery is caught and logged as a warning; the envelope is still returned', t => {
  const s = freshStream(t, 'emit-throws');
  const warn = spyLogger(t, 'warn');
  const emitter = new RunStreamEmitter({
    streamId: s,
    runId: 'chat-run-1',
    deliver: () => {
      throw new Error('socket gone');
    }
  });
  let envelope;
  assert.doesNotThrow(() => {
    envelope = emitter.emit(RUN_STARTED, { kind: 'chat' });
  });
  assertValidEnvelope(envelope);
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0][0], /SSE v2 delivery failed/);
  assert.equal(warn.calls[0][1].error, 'socket gone');
  assert.equal(warn.calls[0][1].type, RUN_STARTED);
});

test('emit: the global delivery (setEnvelopeDelivery) is used when the emitter has no override; non-functions uninstall it', t => {
  const s = freshStream(t, 'global-delivery');
  const global = spyDelivery(t);
  const emitter = new RunStreamEmitter({ streamId: s, runId: 'chat-run-1' });
  const envelope = emitter.emit(RUN_STARTED, { kind: 'chat' });
  assert.deepEqual(global.calls, [[s, envelope]]);

  const local = spy();
  new RunStreamEmitter({ streamId: s, deliver: local }).emit(META, { title: 'x' });
  assert.equal(global.calls.length, 1, 'an override bypasses the global delivery');
  assert.equal(local.calls.length, 1);

  setEnvelopeDelivery('not a function');
  const orphan = emitter.emit(META, { title: 'nobody listening' });
  assertValidEnvelope(orphan);
  assert.equal(global.calls.length, 1, 'no delivery installed → frame is built but goes nowhere');
});

test('RunStreamEmitter requires a streamId', () => {
  assert.throws(() => new RunStreamEmitter(), { message: /requires a streamId/ });
  assert.throws(() => new RunStreamEmitter({ runId: 'chat-run-1' }), {
    message: /requires a streamId/
  });
});

// ── stream ↔ run binding ────────────────────────────────────────────────────

test('bindStreamRun / getStreamRun / unbindStreamRun / streamEmitter binding semantics', t => {
  const s = freshStream(t, 'bind');
  assert.equal(getStreamRun(s), null, 'nothing bound initially');

  const fresh = streamEmitter(s);
  assert.ok(fresh instanceof RunStreamEmitter);
  assert.equal(fresh.streamId, s);
  assert.equal(fresh.runId, null, 'unbound stream → emitter without a run');
  assert.notEqual(streamEmitter(s), fresh, 'unbound: a new emitter every call');

  const bound = new RunStreamEmitter({ streamId: s, runId: 'chat-run-1', deliver: () => {} });
  bindStreamRun(s, 'chat-run-1', bound);
  assert.deepEqual(getStreamRun(s), { runId: 'chat-run-1', emitter: bound });
  assert.equal(streamEmitter(s), bound, 'bound: the producing emitter itself');

  const explicit = streamEmitter(s, 'chat-run-2');
  assert.notEqual(explicit, bound, 'an explicit runId always yields a fresh emitter');
  assert.equal(explicit.runId, 'chat-run-2');
  assert.equal(explicit.streamId, s);

  unbindStreamRun(s, 'chat-run-other');
  assert.equal(getStreamRun(s)?.runId, 'chat-run-1', 'unbinding a different run is a no-op');
  unbindStreamRun(s, 'chat-run-1');
  assert.equal(getStreamRun(s), null);

  bindStreamRun(s, 'chat-run-3', bound);
  unbindStreamRun(s);
  assert.equal(getStreamRun(s), null, 'unbind without a runId clears whatever is bound');

  const rebound = new RunStreamEmitter({ streamId: s, runId: 'chat-run-4', deliver: () => {} });
  bindStreamRun(s, 'chat-run-4', bound);
  bindStreamRun(s, 'chat-run-4', rebound);
  assert.equal(getStreamRun(s).emitter, rebound, 'rebinding replaces the entry');

  resetStream(s);
  assert.equal(getStreamRun(s), null, 'resetStream forgets the binding too');
});

test('emitToolProgress: attaches a tool/progress frame to the run currently producing on the chat stream', t => {
  const s = freshStream(t, 'tool-progress');
  const global = spyDelivery(t);

  assert.equal(emitToolProgress(undefined, { phase: 'search' }), null, 'no chat → no-op');
  assert.equal(emitToolProgress(s, { message: 'no phase' }), null, 'no phase → no-op');
  assert.equal(emitToolProgress(s, null), null);
  assert.equal(global.calls.length, 0);

  const bound = new RunStreamEmitter({ streamId: s, runId: 'chat-run-1' });
  bindStreamRun(s, 'chat-run-1', bound);
  const envelope = emitToolProgress(s, {
    phase: 'search.status',
    message: 42,
    data: { hits: 3 },
    toolId: 'webSearch',
    callId: 'call_1',
    step: 2
  });
  assertValidEnvelope(envelope);
  assert.equal(envelope.type, TOOL_PROGRESS);
  assert.equal(envelope.runId, 'chat-run-1', 'the bound run, not the stream id');
  assert.deepEqual(envelope.data, {
    phase: 'search.status',
    message: '42',
    data: { hits: 3 },
    toolId: 'webSearch',
    callId: 'call_1',
    step: 2
  });
  assert.deepEqual(global.calls, [[s, envelope]]);

  const minimal = emitToolProgress(s, { phase: 'fetch', step: 1.5 });
  assert.deepEqual(minimal.data, { phase: 'fetch' }, 'non-integer step and absent fields dropped');

  unbindStreamRun(s);
  const orphan = emitToolProgress(s, { phase: 'late' });
  assert.equal(orphan.runId, s, 'no run in flight → the stream id stands in');
});

// ── checkpoint → interaction ────────────────────────────────────────────────

const baseCheckpoint = {
  id: 'cp-1',
  nodeId: 'approve-node',
  nodeName: 'Approve budget',
  type: 'approval',
  title: 'Approval needed',
  message: 'Approve the Q3 budget?',
  options: [
    { value: 'yes', label: 'Approve', description: 'Go ahead', style: 'primary' },
    { label: 'Reject' },
    { value: 'later' }
  ],
  showData: ['budget.total'],
  displayData: { 'budget.total': 1200 },
  timeout: 60000,
  expiresAt: '2026-09-02T13:00:00.000Z',
  createdAt: '2026-09-02T12:00:00.000Z'
};

test('checkpointToInteraction: approval checkpoint → approval interaction with coerced options', () => {
  const interaction = checkpointToInteraction(baseCheckpoint, {
    runId: 'workflow-run-1',
    executionId: 'exec-1',
    step: 3,
    chatId: 'chat-9'
  });
  assert.doesNotThrow(() => interactionSchema.parse(interaction));
  assert.equal(interaction.id, 'cp-1');
  assert.equal(interaction.runId, 'workflow-run-1');
  assert.equal(interaction.step, 3);
  assert.equal(interaction.kind, 'approval');
  assert.equal(interaction.origin, 'node');
  assert.equal(interaction.status, 'pending');
  assert.equal(interaction.createdAt, '2026-09-02T12:00:00.000Z');
  assert.deepEqual(interaction.prompt, {
    message: 'Approve the Q3 budget?',
    title: 'Approval needed',
    inputType: 'single_select',
    options: [
      { value: 'yes', label: 'Approve', description: 'Go ahead', style: 'primary' },
      { value: 'Reject', label: 'Reject' },
      { value: 'later', label: 'later' }
    ],
    inputSchema: null,
    showData: ['budget.total'],
    displayData: { 'budget.total': 1200 },
    allowSkip: false,
    allowOther: false
  });
  assert.deepEqual(interaction.policy, {
    expiresAt: '2026-09-02T13:00:00.000Z',
    timeoutMs: 60000,
    onTimeout: 'fail',
    fallback: 'park'
  });
  assert.deepEqual(interaction.source, {
    nodeId: 'approve-node',
    nodeName: 'Approve budget',
    executionId: 'exec-1',
    chatId: 'chat-9',
    checkpointId: 'cp-1'
  });
});

test('checkpointToInteraction: kind and inputType per checkpoint type (approval / review / input / unknown)', () => {
  const ctx = { runId: 'workflow-run-1', executionId: 'exec-1' };
  const kinds = type => {
    const i = checkpointToInteraction({ ...baseCheckpoint, type }, ctx);
    interactionSchema.parse(i);
    return [i.kind, i.prompt.inputType];
  };
  assert.deepEqual(kinds('approval'), ['approval', 'single_select']);
  assert.deepEqual(kinds('review'), ['review', 'single_select']);
  assert.deepEqual(kinds('input'), ['question', 'text'], 'input ignores options for the widget');
  assert.deepEqual(kinds('something-new'), ['approval', 'single_select'], 'unknown → approval');

  const noOptions = checkpointToInteraction({ ...baseCheckpoint, options: undefined }, ctx);
  assert.equal(noOptions.prompt.inputType, 'confirm');
  assert.equal(noOptions.prompt.options, undefined);

  const emptyOptions = checkpointToInteraction({ ...baseCheckpoint, options: [] }, ctx);
  assert.equal(emptyOptions.prompt.inputType, 'confirm');
  assert.deepEqual(emptyOptions.prompt.options, []);

  const form = checkpointToInteraction(
    {
      ...baseCheckpoint,
      type: 'input',
      inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }
    },
    ctx
  );
  assert.equal(form.kind, 'question');
  assert.equal(form.prompt.inputType, 'form');
  assert.deepEqual(form.prompt.inputSchema, {
    type: 'object',
    properties: { amount: { type: 'number' } }
  });
});

test('checkpointToInteraction: fallbacks — synthetic id, message from title, defaults for policy/source, tolerates a missing checkpoint', () => {
  const bare = checkpointToInteraction(
    { nodeId: 'n1', type: 'review', title: 'Look at this' },
    { executionId: 'exec-2' }
  );
  assert.doesNotThrow(() => interactionSchema.parse(bare));
  assert.equal(bare.id, 'exec-2:n1', 'no checkpoint id → <executionId>:<nodeId>');
  assert.equal(bare.runId, 'exec-2', 'no runId → executionId');
  assert.equal(bare.step, 0);
  assert.equal(bare.prompt.message, 'Look at this', 'message falls back to the title');
  assert.equal(bare.prompt.inputType, 'confirm');
  assert.equal(bare.prompt.showData, null, 'non-array showData → null');
  assert.equal(bare.prompt.displayData, undefined);
  assert.deepEqual(bare.policy, {
    expiresAt: null,
    timeoutMs: null,
    onTimeout: 'fail',
    fallback: 'park'
  });
  assert.deepEqual(bare.source, { nodeId: 'n1', executionId: 'exec-2', checkpointId: '' });
  assert.ok(!Number.isNaN(Date.parse(bare.createdAt)), 'createdAt minted when absent');

  const nothing = checkpointToInteraction(undefined, { runId: 'workflow-run-3' });
  assert.equal(nothing.id, 'workflow-run-3:checkpoint');
  assert.equal(nothing.prompt.message, 'Your input is required');
  assert.equal(nothing.kind, 'approval');
  assert.equal(nothing.source.nodeId, undefined);
  assert.equal(nothing.source.checkpointId, '');
  assert.doesNotThrow(() => interactionSchema.parse(nothing));
});

// ── internal bus → v2 ───────────────────────────────────────────────────────

const EXEC = { executionId: 'exec-42', chatId: 'chat-7' };

test('translateInternalEvent: garbage in → [], runId is executionId, else chatId', () => {
  assert.deepEqual(translateInternalEvent(undefined), []);
  assert.deepEqual(translateInternalEvent(null), []);
  assert.deepEqual(translateInternalEvent({}), []);
  assert.deepEqual(translateInternalEvent({ event: 42 }), []);
  assert.deepEqual(translateInternalEvent({ event: 'something.else', ...EXEC }), []);
  assert.deepEqual(
    translateInternalEvent({ event: 'chunk', chatId: 'c' }),
    [],
    'legacy names are gone'
  );

  assert.equal(translateInternalEvent({ event: 'workflow.paused', ...EXEC })[0].runId, 'exec-42');
  assert.equal(
    translateInternalEvent({ event: 'workflow.paused', chatId: 'chat-7' })[0].runId,
    'chat-7'
  );
});

test('translateInternalEvent: workflow.start → run/started{workflow}', () => {
  const out = translated({
    event: 'workflow.start',
    ...EXEC,
    workflowId: 'wf-1',
    startNodes: ['a', 'b'],
    unrelated: true
  });
  assert.deepEqual(out, [
    {
      type: RUN_STARTED,
      runId: 'exec-42',
      data: {
        kind: 'workflow',
        refs: { executionId: 'exec-42', workflowId: 'wf-1', startNodes: ['a', 'b'] }
      }
    }
  ]);
  const minimal = translated({ event: 'workflow.start', chatId: 'chat-7' });
  assert.deepEqual(minimal[0].data, { kind: 'workflow', refs: {} }, 'undefined refs are omitted');
});

test('translateInternalEvent: workflow.iteration → progress/node{__loop__, running, iteration}', () => {
  const out = translated({
    event: 'workflow.iteration',
    ...EXEC,
    iteration: 3,
    loopNodeId: 'loop-1',
    maxIterations: 10
  });
  assert.deepEqual(out, [
    {
      type: PROGRESS_NODE,
      runId: 'exec-42',
      data: {
        executionId: 'exec-42',
        nodeId: '__loop__',
        status: 'running',
        iteration: 3,
        progress: { kind: 'iteration', loopNodeId: 'loop-1', maxIterations: 10 }
      }
    }
  ]);
  const named = translated({
    event: 'workflow.iteration',
    ...EXEC,
    nodeId: 'my-loop',
    iteration: '2'
  });
  assert.equal(named[0].data.nodeId, 'my-loop');
  assert.equal(named[0].data.iteration, undefined, 'non-integer iteration is dropped');
});

test('translateInternalEvent: workflow.node.start / complete / error / progress → progress/node', () => {
  const start = translated({ event: 'workflow.node.start', ...EXEC, nodeId: 7, nodeType: 'agent' });
  assert.deepEqual(start[0], {
    type: PROGRESS_NODE,
    runId: 'exec-42',
    data: { executionId: 'exec-42', nodeId: '7', nodeType: 'agent', status: 'running' }
  });
  assert.equal(
    translated({ event: 'workflow.node.start', ...EXEC, nodeId: 'n' })[0].data.nodeType,
    undefined
  );

  const complete = translated({
    event: 'workflow.node.complete',
    ...EXEC,
    nodeId: 'n1',
    result: { output: 'done', iteration: 2 }
  });
  assert.deepEqual(complete[0].data, {
    executionId: 'exec-42',
    nodeId: 'n1',
    status: 'completed',
    iteration: 2,
    output: { output: 'done', iteration: 2 }
  });
  assert.equal(
    translated({ event: 'workflow.node.complete', ...EXEC, nodeId: 'n1', result: 'text' })[0].data
      .iteration,
    undefined
  );

  const errObj = translated({
    event: 'workflow.node.error',
    ...EXEC,
    nodeId: 'n1',
    error: { message: 'boom', code: 'X' }
  });
  assert.deepEqual(errObj[0].data, {
    executionId: 'exec-42',
    nodeId: 'n1',
    status: 'failed',
    error: 'boom'
  });
  assert.equal(
    translated({ event: 'workflow.node.error', ...EXEC, nodeId: 'n1', error: 'plain' })[0].data
      .error,
    'plain'
  );
  assert.equal(
    translated({ event: 'workflow.node.error', ...EXEC, nodeId: 'n1' })[0].data.error,
    'error'
  );

  const progress = translated({
    event: 'workflow.node.progress',
    ...EXEC,
    nodeId: 'n1',
    status: 'paused',
    message: 'waiting'
  });
  assert.deepEqual(progress[0].data, {
    executionId: 'exec-42',
    nodeId: 'n1',
    status: 'paused',
    progress: { message: 'waiting' }
  });
  const anon = translated({ event: 'workflow.node.progress', ...EXEC, message: 'm' });
  assert.equal(anon[0].data.nodeId, 'progress');
  assert.equal(anon[0].data.status, 'running');
});

test('translateInternalEvent: workflow.paused → run/paused{manual}', () => {
  assert.deepEqual(translated({ event: 'workflow.paused', ...EXEC }), [
    { type: RUN_PAUSED, runId: 'exec-42', data: { reason: 'manual' } }
  ]);
});

test('translateInternalEvent: workflow.human.required → interaction/raised + run/paused{interaction}', () => {
  const out = translated({ event: 'workflow.human.required', ...EXEC, checkpoint: baseCheckpoint });
  assert.deepEqual(
    out.map(o => o.type),
    [INTERACTION_RAISED, RUN_PAUSED]
  );
  const { interaction } = out[0].data;
  assert.doesNotThrow(() => interactionSchema.parse(interaction));
  assert.equal(interaction.id, 'cp-1');
  assert.equal(interaction.runId, 'exec-42');
  assert.equal(interaction.kind, 'approval');
  assert.equal(interaction.source.checkpointId, 'cp-1');
  assert.equal(interaction.source.executionId, 'exec-42');
  assert.deepEqual(out[1].data, { reason: 'interaction', interactionId: 'cp-1' });
  assert.deepEqual(
    out.map(o => o.runId),
    ['exec-42', 'exec-42']
  );
});

test('translateInternalEvent: workflow.human.responded → interaction/answered + run/resumed', () => {
  const out = translated({
    event: 'workflow.human.responded',
    ...EXEC,
    checkpointId: 'cp-1',
    checkpoint: { id: 'cp-1', type: 'input' },
    response: 'yes',
    data: { comment: 'ok' },
    respondedBy: 'alice'
  });
  assert.deepEqual(
    out.map(o => o.type),
    [INTERACTION_ANSWERED, RUN_RESUMED]
  );
  const answered = out[0].data;
  assert.equal(answered.interactionId, 'cp-1');
  assert.equal(answered.kind, 'question', 'kind follows the checkpoint type');
  assert.equal(answered.answer.value, 'yes');
  assert.deepEqual(answered.answer.data, { comment: 'ok' });
  assert.equal(answered.answer.by, 'alice');
  assert.equal(answered.answer.channel, 'run_page');
  assert.ok(!Number.isNaN(Date.parse(answered.answer.at)));
  assert.deepEqual(out[1].data, { interactionId: 'cp-1' });

  const sparse = translated({
    event: 'workflow.human.responded',
    ...EXEC,
    checkpoint: { id: 'cp-2', type: 'approval' },
    answer: { value: 'approve' }
  });
  assert.equal(sparse[0].data.interactionId, 'cp-2', 'falls back to checkpoint.id');
  assert.equal(sparse[0].data.kind, 'approval');
  assert.equal(sparse[0].data.answer.value, 'approve', 'answer.value when no response');
  assert.equal(sparse[0].data.answer.by, 'user');
  assert.equal(sparse[0].data.answer.data, undefined);

  const bare = translated({ event: 'workflow.human.responded', ...EXEC });
  assert.equal(bare[0].data.interactionId, 'checkpoint');
  assert.equal(bare[0].data.kind, 'approval');
  assert.equal(bare[0].data.answer.value, null);
});

test('translateInternalEvent: workflow.complete → run/ended with normalised status and the custom status as finishReason', () => {
  const plain = translated({ event: 'workflow.complete', ...EXEC, output: { text: 'hi' } });
  assert.deepEqual(plain, [
    {
      type: RUN_ENDED,
      runId: 'exec-42',
      data: { status: 'completed', finishReason: null, output: { text: 'hi' } }
    }
  ]);
  assert.deepEqual(
    translated({ event: 'workflow.complete', ...EXEC, status: 'completed' })[0].data,
    { status: 'completed', finishReason: null }
  );
  assert.deepEqual(
    translated({ event: 'workflow.complete', ...EXEC, status: 'approved' })[0].data,
    {
      status: 'completed',
      finishReason: 'approved'
    }
  );
  assert.deepEqual(translated({ event: 'workflow.complete', ...EXEC, status: 'failed' })[0].data, {
    status: 'error',
    finishReason: 'failed'
  });
  assert.deepEqual(translated({ event: 'workflow.complete', ...EXEC, status: 'error' })[0].data, {
    status: 'error',
    finishReason: 'error'
  });
  assert.deepEqual(
    translated({ event: 'workflow.complete', ...EXEC, status: 'cancelled' })[0].data,
    { status: 'aborted', finishReason: 'cancelled' }
  );
  assert.deepEqual(translated({ event: 'workflow.complete', ...EXEC, status: 'aborted' })[0].data, {
    status: 'aborted',
    finishReason: 'aborted'
  });
  assert.equal(
    translated({ event: 'workflow.complete', ...EXEC, output: null })[0].data.output,
    null,
    'an explicit null output is kept'
  );
});

test('translateInternalEvent: workflow.failed / workflow.cancelled → run/ended{error | aborted}', () => {
  assert.deepEqual(
    translated({ event: 'workflow.failed', ...EXEC, error: { message: 'kaput', code: 'E1' } })[0]
      .data,
    { status: 'error', finishReason: 'error', error: { message: 'kaput', code: 'E1' } }
  );
  assert.deepEqual(translated({ event: 'workflow.failed', ...EXEC, error: 'plain' })[0].data, {
    status: 'error',
    finishReason: 'error',
    error: { message: 'plain' }
  });
  assert.deepEqual(translated({ event: 'workflow.failed', ...EXEC })[0].data, {
    status: 'error',
    finishReason: 'error',
    error: { message: 'Workflow failed' }
  });

  assert.deepEqual(translated({ event: 'workflow.cancelled', ...EXEC })[0].data, {
    status: 'aborted',
    finishReason: 'cancelled'
  });
  assert.deepEqual(
    translated({ event: 'workflow.cancelled', ...EXEC, reason: 'user stopped' })[0].data,
    { status: 'aborted', finishReason: 'cancelled', error: { message: 'user stopped' } }
  );
});

test('translateInternalEvent: workflow.checkpoint.saved / workflow.plan.created → meta{extra}', () => {
  assert.deepEqual(translated({ event: 'workflow.checkpoint.saved', ...EXEC }), [
    {
      type: META,
      runId: 'exec-42',
      data: { executionId: 'exec-42', extra: { checkpointSaved: true } }
    }
  ]);
  const plan = { steps: ['a', 'b'] };
  assert.deepEqual(translated({ event: 'workflow.plan.created', ...EXEC, plan })[0].data, {
    executionId: 'exec-42',
    extra: { planCreated: plan }
  });
  assert.deepEqual(translated({ event: 'workflow.plan.created', ...EXEC })[0].data.extra, {
    planCreated: null
  });
});

test('translateInternalEvent: workflow.subworkflow.start / complete → progress/node{sub:<child>}', () => {
  const start = translated({
    event: 'workflow.subworkflow.start',
    ...EXEC,
    data: { executionId: 'child-1', depth: 2, taskCount: 5, status: 'running', noise: true }
  });
  assert.deepEqual(start, [
    {
      type: PROGRESS_NODE,
      runId: 'exec-42',
      data: {
        executionId: 'exec-42',
        nodeId: 'sub:child-1',
        nodeType: 'subworkflow',
        status: 'running',
        progress: { executionId: 'child-1', depth: 2, taskCount: 5, status: 'running' }
      }
    }
  ]);

  const complete = translated({
    event: 'workflow.subworkflow.complete',
    ...EXEC,
    subExecutionId: 'child-2',
    depth: 1
  });
  assert.equal(complete[0].data.nodeId, 'sub:child-2', 'falls back to subExecutionId');
  assert.equal(complete[0].data.status, 'completed');
  assert.deepEqual(complete[0].data.progress, { executionId: 'child-2', depth: 1 });

  const own = translated({ event: 'workflow.subworkflow.complete', ...EXEC });
  assert.equal(own[0].data.nodeId, 'sub:exec-42', 'last resort: the parent execution id');
});

test('translateInternalEvent: agent.* → tool/progress{phase:<event>} with the envelope keys stripped', () => {
  const out = translated({
    event: 'agent.thinking',
    ...EXEC,
    _parentRunId: 'parent-1',
    message: 'Pondering…',
    tokens: 12
  });
  assert.deepEqual(out, [
    {
      type: TOOL_PROGRESS,
      runId: 'exec-42',
      data: {
        phase: 'agent.thinking',
        message: 'Pondering…',
        data: { executionId: 'exec-42', message: 'Pondering…', tokens: 12 }
      }
    }
  ]);
  assert.equal(
    Object.hasOwn(out[0].data.data, '_parentRunId'),
    false,
    'internal routing keys never reach the client'
  );
  assert.equal(Object.hasOwn(out[0].data.data, 'chatId'), false);
  assert.equal(Object.hasOwn(out[0].data.data, 'event'), false);

  const noMessage = translated({ event: 'agent.tool.call', ...EXEC, message: { not: 'a string' } });
  assert.equal(noMessage[0].data.message, undefined, 'non-string message is not lifted');
  assert.deepEqual(
    noMessage[0].data.data.message,
    { not: 'a string' },
    '…but stays in the payload'
  );

  assert.deepEqual(
    translateInternalEvent({ event: 'agentless', ...EXEC }),
    [],
    'prefix must match'
  );
});

// ── ledger → v2 (re-sync) ───────────────────────────────────────────────────

const LEDGER = { seq: 17, ts: '2026-09-02T12:00:00.000Z', runId: 'chat-run-1' };
const ledgerEvent = (type, data) => ({ ...LEDGER, type, data });

/** Project one ledger event and validate every envelope. */
function projected(type, data) {
  const out = projectLedgerEvent(ledgerEvent(type, data));
  for (const envelope of out) {
    assertValidEnvelope(envelope);
    assert.equal(envelope.seq, 17, 'keeps the ledger seq');
    assert.equal(envelope.ts, LEDGER.ts, 'keeps the ledger timestamp');
    assert.equal(envelope.runId, 'chat-run-1');
    assert.equal(envelope.v, 2);
  }
  return out;
}

test('projectLedgerEvent: garbage and unknown types → []', () => {
  assert.deepEqual(projectLedgerEvent(undefined), []);
  assert.deepEqual(projectLedgerEvent(null), []);
  assert.deepEqual(projectLedgerEvent('run/start'), []);
  assert.deepEqual(projected('segment/start', {}), []);
  assert.deepEqual(projected(RUN_LOG_EVENTS.REQUEST_HEADER, {}), []);
  assert.deepEqual(projected(RUN_LOG_EVENTS.MESSAGE_USER, { content: 'hi' }), []);
  assert.deepEqual(projected(RUN_LOG_EVENTS.TOOL_DISABLED, {}), []);
  assert.deepEqual(projected(RUN_LOG_EVENTS.BUDGET_CHECKPOINT, {}), []);
  assert.deepEqual(projected('human/event', {}), []);
  assert.deepEqual(projected('nonsense', {}), []);
});

test('projectLedgerEvent: run/start → run/started', () => {
  const [full] = projected(RUN_LOG_EVENTS.RUN_START, {
    kind: 'workflow',
    parentRunId: 'chat-run-0',
    model: { id: 'oa', provider: 'openai' },
    refs: { executionId: 'exec-1' }
  });
  assert.equal(full.type, RUN_STARTED);
  assert.deepEqual(full.data, {
    kind: 'workflow',
    parentRunId: 'chat-run-0',
    model: 'oa',
    refs: { executionId: 'exec-1' }
  });
  const [minimal] = projected(RUN_LOG_EVENTS.RUN_START, { model: 'gm' });
  assert.deepEqual(minimal.data, { kind: 'chat', model: 'gm', refs: {} }, 'kind defaults to chat');
  const [empty] = projectLedgerEvent({ ...LEDGER, type: RUN_LOG_EVENTS.RUN_START });
  assert.deepEqual(empty.data, { kind: 'chat', refs: {} }, 'missing data tolerated');
});

test('projectLedgerEvent: run/end → run/ended', () => {
  const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
  const [full] = projected(RUN_LOG_EVENTS.RUN_END, {
    status: 'error',
    finishReason: 'error',
    usage,
    error: { code: 'E', message: 'bad' },
    durationMs: 5
  });
  assert.equal(full.type, RUN_ENDED);
  assert.deepEqual(full.data, {
    status: 'error',
    finishReason: 'error',
    usage,
    error: { code: 'E', message: 'bad' }
  });
  const [minimal] = projected(RUN_LOG_EVENTS.RUN_END, {});
  assert.deepEqual(minimal.data, { status: 'completed', finishReason: null });
});

test('projectLedgerEvent: run/paused, run/resumed', () => {
  const [paused] = projected(RUN_LOG_EVENTS.RUN_PAUSED, { reason: 'manual', interactionId: 'i1' });
  assert.equal(paused.type, RUN_PAUSED);
  assert.deepEqual(paused.data, { reason: 'manual', interactionId: 'i1' });
  // The projection passes `d.interactionId` through even when absent; on the
  // wire (JSON) that key disappears, so compare the serialised form.
  const wire = data => JSON.parse(JSON.stringify(data));
  const [defaultPause] = projected(RUN_LOG_EVENTS.RUN_PAUSED, {});
  assert.deepEqual(wire(defaultPause.data), { reason: 'interaction' });
  assert.equal(defaultPause.data.interactionId, undefined);

  const [resumed] = projected(RUN_LOG_EVENTS.RUN_RESUMED, { interactionId: 'i1' });
  assert.equal(resumed.type, RUN_RESUMED);
  assert.deepEqual(resumed.data, { interactionId: 'i1' });
  assert.deepEqual(wire(projected(RUN_LOG_EVENTS.RUN_RESUMED, {})[0].data), {});
});

test('projectLedgerEvent: message/assistant → step/completed', () => {
  const toolCalls = [{ id: 'c1', index: 0, type: 'function', name: 'webSearch', arguments: '{}' }];
  const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
  const [full] = projected(RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
    step: 2,
    content: 'Sunny.',
    toolCalls,
    finishReason: 'tool_calls',
    usage,
    groundingMetadata: { chunks: [] },
    thinkingChars: 12
  });
  assert.equal(full.type, STEP_COMPLETED);
  assert.deepEqual(full.data, {
    step: 2,
    content: 'Sunny.',
    toolCalls,
    finishReason: 'tool_calls',
    usage,
    groundingMetadata: { chunks: [] }
  });
  const [minimal] = projected(RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {});
  assert.deepEqual(minimal.data, { step: 0, content: '', toolCalls: [], finishReason: null });
});

test('projectLedgerEvent: tool/call → tool/started, tool/result → tool/completed', () => {
  const [started] = projected(RUN_LOG_EVENTS.TOOL_CALL, {
    step: 1,
    callId: 7,
    toolId: 'webSearch',
    args: { q: 'x' },
    execution: 'passthrough'
  });
  assert.equal(started.type, TOOL_STARTED);
  assert.deepEqual(started.data, {
    step: 1,
    callId: '7',
    toolId: 'webSearch',
    name: 'webSearch',
    args: { q: 'x' },
    execution: 'passthrough'
  });
  const [defaults] = projected(RUN_LOG_EVENTS.TOOL_CALL, {
    callId: 'c',
    toolId: 't',
    name: 'pretty'
  });
  assert.deepEqual(defaults.data, {
    step: 0,
    callId: 'c',
    toolId: 't',
    name: 'pretty',
    args: undefined,
    execution: 'server'
  });

  const [completed] = projected(RUN_LOG_EVENTS.TOOL_RESULT, {
    step: 1,
    callId: 'c1',
    toolId: 'webSearch',
    resultPreview: { hits: 3 },
    error: { code: 'E', message: 'failed', stack: 'x' },
    durationMs: 12,
    knowledgeSource: 'websearch'
  });
  assert.equal(completed.type, TOOL_COMPLETED);
  assert.deepEqual(completed.data, {
    step: 1,
    callId: 'c1',
    toolId: 'webSearch',
    name: 'webSearch',
    resultPreview: { hits: 3 },
    error: { message: 'failed' },
    durationMs: 12,
    knowledgeSource: 'websearch'
  });
  const [bare] = projected(RUN_LOG_EVENTS.TOOL_RESULT, {
    callId: 'c1',
    toolId: 't',
    error: {},
    durationMs: 1.5
  });
  assert.deepEqual(bare.data, {
    step: 0,
    callId: 'c1',
    toolId: 't',
    name: 't',
    resultPreview: null,
    error: { message: 'error' }
  });
});

test('projectLedgerEvent: interaction/raised and interaction/answered project only when complete', () => {
  const interaction = checkpointToInteraction(baseCheckpoint, {
    runId: 'chat-run-1',
    executionId: 'exec-1'
  });
  const [raised] = projected(RUN_LOG_EVENTS.INTERACTION_RAISED, { interaction });
  assert.equal(raised.type, INTERACTION_RAISED);
  assert.equal(raised.data.interaction.id, 'cp-1');
  assert.deepEqual(projected(RUN_LOG_EVENTS.INTERACTION_RAISED, {}), []);

  const answer = { value: 'yes', by: 'alice', at: LEDGER.ts, channel: 'chat' };
  const [answered] = projected(RUN_LOG_EVENTS.INTERACTION_ANSWERED, {
    interactionId: 'cp-1',
    kind: 'approval',
    answer
  });
  assert.equal(answered.type, INTERACTION_ANSWERED);
  assert.deepEqual(answered.data, { interactionId: 'cp-1', kind: 'approval', answer });
  const [defaultKind] = projected(RUN_LOG_EVENTS.INTERACTION_ANSWERED, {
    interactionId: 'cp-1',
    answer
  });
  assert.equal(defaultKind.data.kind, 'question');
  assert.deepEqual(projected(RUN_LOG_EVENTS.INTERACTION_ANSWERED, { interactionId: 'cp-1' }), []);
  assert.deepEqual(projected(RUN_LOG_EVENTS.INTERACTION_ANSWERED, { answer }), []);
});

test('projectLedgerEvent: error → stream/error with retryable = recoverable', () => {
  const [full] = projected(RUN_LOG_EVENTS.ERROR, {
    code: 'PROVIDER_ERROR',
    message: 'boom',
    recoverable: true,
    stack: 'hidden'
  });
  assert.equal(full.type, STREAM_ERROR);
  assert.deepEqual(full.data, { code: 'PROVIDER_ERROR', message: 'boom', retryable: true });
  const [minimal] = projected(RUN_LOG_EVENTS.ERROR, {});
  assert.deepEqual(minimal.data, { code: 'ERROR', message: 'error', retryable: false });
  const [notRecoverable] = projected(RUN_LOG_EVENTS.ERROR, { recoverable: 'yes' });
  assert.equal(notRecoverable.data.retryable, false, 'only boolean true counts');
});

test('stream registry: resetStream forgets the counter and binding; the registry is bounded', async () => {
  const {
    nextSeq,
    currentSeq,
    resetStream,
    bindStreamRun,
    getStreamRun,
    trackedStreamCount,
    MAX_TRACKED_STREAMS
  } = await import('../../services/loop/RunStream.js');
  const id = `evict-${Date.now()}`;
  nextSeq(id);
  nextSeq(id);
  bindStreamRun(id, 'run-x', { emit() {} });
  assert.equal(currentSeq(id), 2);
  const bound = getStreamRun(id);
  assert.equal(bound && typeof bound === 'object' ? bound.runId : bound, 'run-x');
  resetStream(id);
  assert.equal(currentSeq(id), 0);
  assert.equal(getStreamRun(id), null);
  assert.ok(Number.isInteger(MAX_TRACKED_STREAMS) && MAX_TRACKED_STREAMS > 0);
  assert.ok(trackedStreamCount() <= MAX_TRACKED_STREAMS);
});
