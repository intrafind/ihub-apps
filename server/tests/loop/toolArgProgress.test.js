// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The live progress of a tool call whose arguments are still streaming, and of
 * a model that says nothing (issue #3534): the tracker that decides which
 * `args` / `args.ended` frames to send, the waiting line, and the chat seam
 * that feeds them.
 *
 * Time is a parameter (`now`) for the tracker and fake timers for the waiting
 * line and the seam. The seam is driven with hand-made chunks; the whole path
 * through the real loop and converters is `chatToolProgress.test.js`.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_ARG_PROGRESS,
  argsOutcomeOf,
  createToolArgTracker,
  createWaitingLine,
  isArgStreamAnnounceable
} from '../../services/chat/toolArgProgress.js';
import { chatToolSeam } from '../../services/chat/chatSeams.js';
import { buildEnvelope } from '../../services/loop/RunStream.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { ARGS_OUTCOMES, PROGRESS_PHASES } from '../../../shared/run/argProgress.js';

const { ANNOUNCE_AFTER_MS, MIN_FRAME_INTERVAL_MS, WAITING_AFTER_MS } = TOOL_ARG_PROGRESS;
/**
 * While fragments flow a call is reported at least this often. The throttle is
 * driven by the chunks themselves, so this is a property of the 1 s throttle and
 * the test's fragment pace, not a setting.
 */
const MAX_FRAME_GAP_MS = 2000;

// ── tools ───────────────────────────────────────────────────────────────────

const creator = {
  id: 'create_web_artifact',
  name: 'Create interactive web artifact',
  isSystemSkillTool: true,
  outputKind: 'webArtifact'
};
const createFile = {
  id: 'create_file',
  name: 'create_file',
  isSystemSkillTool: true,
  outputKind: 'file'
};
// A system-skill tool that makes nothing: its arguments are not a deliverable.
const previewPdf = { id: 'preview_pdf', name: 'preview_pdf', isSystemSkillTool: true };
const mcpTool = {
  id: 'mcp_wiki__create_page',
  name: 'mcp_wiki__create_page',
  _mcp: { serverId: 'wiki', serverName: 'Wiki', originalName: 'create_page' }
};
const search = { id: 'webSearch', name: 'webSearch' };
const catalogue = [
  creator,
  createFile,
  previewPdf,
  mcpTool,
  search,
  { id: 'activate_skill', name: 'Activate Skill', isInternalTool: true },
  { id: 'ask_user', name: 'ask_user', interactive: true },
  { id: 'workflow_x', name: 'workflow_x', passthrough: true }
];
const resolveTool = name => catalogue.find(t => t.id === name) ?? null;

/** A clock the test moves by hand. */
function clock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = ms => {
    t += ms;
  };
  return now;
}

const entry = (index, id, name, argBytes) => ({
  index,
  ...(id ? { id } : {}),
  ...(name ? { name } : {}),
  argBytes
});

// ── which calls are announced ───────────────────────────────────────────────

test('a system-skill tool is announced at once, with what the chat needs to draw its row', () => {
  const now = clock(1000);
  const tracker = createToolArgTracker({ now });
  const frames = tracker.observe([entry(0, 'call_1', 'create_web_artifact', 0)], resolveTool);
  assert.deepEqual(frames, [
    {
      phase: 'args',
      callId: 'call_1',
      toolId: 'create_web_artifact',
      data: {
        name: 'create_web_artifact',
        title: 'Create interactive web artifact',
        activityKind: 'tool',
        outputKind: 'webArtifact',
        argBytes: 0,
        elapsedMs: 0
      }
    }
  ]);
  assert.equal(tracker.hasOpenCalls(), true);
});

test('any other tool is announced only once its arguments are still streaming after 1.5 s', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  assert.deepEqual(tracker.observe([entry(0, 'c1', 'mcp_wiki__create_page', 10)], resolveTool), []);
  now.advance(ANNOUNCE_AFTER_MS - 1);
  assert.deepEqual(
    tracker.observe([entry(0, 'c1', 'mcp_wiki__create_page', 900)], resolveTool),
    []
  );
  assert.equal(tracker.hasOpenCalls(), false);
  now.advance(1);
  const [frame] = tracker.observe([entry(0, 'c1', 'mcp_wiki__create_page', 2000)], resolveTool);
  assert.equal(frame.phase, 'args');
  assert.equal(frame.callId, 'c1');
  assert.equal(frame.toolId, 'mcp_wiki__create_page');
  assert.equal(frame.data.title, 'create_page');
  assert.equal(frame.data.integration, 'Wiki');
  assert.equal(frame.data.argBytes, 2000);
  assert.equal(frame.data.elapsedMs, ANNOUNCE_AFTER_MS, 'counted from the first fragment');
  assert.equal('outputKind' in frame.data, false);
});

test('a system-skill tool that makes nothing waits for the 1.5 s rule like any other tool', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  assert.deepEqual(tracker.observe([entry(0, 'p1', 'preview_pdf', 10)], resolveTool), []);
  assert.equal(tracker.hasOpenCalls(), false, 'not announced at once');
  now.advance(ANNOUNCE_AFTER_MS);
  const [frame] = tracker.observe([entry(0, 'p1', 'preview_pdf', 3000)], resolveTool);
  assert.equal(frame.phase, 'args');
  assert.equal(frame.toolId, 'preview_pdf');
  assert.equal('outputKind' in frame.data, false);
});

test('a fast call of another tool leaves nothing behind: no frame, not even at the end', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  assert.deepEqual(tracker.observe([entry(0, 'c1', 'webSearch', 5)], resolveTool), []);
  now.advance(300);
  assert.deepEqual(tracker.observe([entry(0, 'c1', 'webSearch', 40)], resolveTool), []);
  assert.deepEqual(
    tracker.close({
      outcome: 'completed',
      result: {
        toolCalls: [{ id: 'c1', index: 0, function: { name: 'webSearch', arguments: '{}' } }]
      }
    }),
    []
  );
});

test('a hallucinated name, a loop tool, ask_user and a passthrough tool are never announced', () => {
  for (const name of ['no_such_tool', 'activate_skill', 'ask_user', 'workflow_x']) {
    const now = clock();
    const tracker = createToolArgTracker({ now });
    assert.deepEqual(tracker.observe([entry(0, 'c1', name, 0)], resolveTool), [], name);
    now.advance(10_000);
    assert.deepEqual(tracker.observe([entry(0, 'c1', name, 99_999)], resolveTool), [], name);
    assert.equal(tracker.hasOpenCalls(), false);
    assert.deepEqual(tracker.close({ outcome: 'aborted' }), []);
  }
  assert.equal(isArgStreamAnnounceable(null), false);
  assert.equal(isArgStreamAnnounceable({ id: 'x' }), true);
});

test('nothing is announced before the id is known (risk R2); the row then carries that id', () => {
  const tracker = createToolArgTracker({ now: clock() });
  assert.deepEqual(tracker.observe([entry(0, null, 'create_web_artifact', 0)], resolveTool), []);
  assert.deepEqual(tracker.observe([entry(0, null, 'create_web_artifact', 400)], resolveTool), []);
  const [frame] = tracker.observe([entry(0, 'late_id', 'create_web_artifact', 800)], resolveTool);
  assert.equal(frame.callId, 'late_id');
  assert.equal(frame.data.argBytes, 800);
  // A call that never gets a name stays silent.
  assert.deepEqual(tracker.observe([entry(1, 'only_id', null, 100)], resolveTool), []);
});

test('two calls of one model call are tracked by their index', () => {
  const tracker = createToolArgTracker({ now: clock() });
  const frames = tracker.observe(
    [entry(0, 'a', 'create_file', 0), entry(1, 'b', 'create_web_artifact', 0)],
    resolveTool
  );
  assert.deepEqual(
    frames.map(f => [f.callId, f.toolId]),
    [
      ['a', 'create_file'],
      ['b', 'create_web_artifact']
    ]
  );
});

// ── occurrence ──────────────────────────────────────────────────────────────

test('occurrence counts the announced calls of one tool in the turn: none, then 2, then 3', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  const announced = [];
  for (let step = 1; step <= 3; step++) {
    const [frame] = tracker.observe(
      [entry(0, `call_${step}`, 'create_web_artifact', 0)],
      resolveTool
    );
    announced.push(frame.data.occurrence);
    // Another tool does not count towards it.
    tracker.observe([entry(1, `f_${step}`, 'create_file', 0)], resolveTool);
    tracker.close({ outcome: 'completed', result: { toolCalls: [] } });
    now.advance(5000);
  }
  assert.deepEqual(announced, [undefined, 2, 3]);
});

test('a call that was never announced does not count towards occurrence', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  for (let i = 0; i < 3; i++) {
    tracker.observe([entry(0, `s${i}`, 'webSearch', 3)], resolveTool);
    tracker.close({ outcome: 'completed', result: { toolCalls: [] } });
  }
  tracker.observe([entry(0, 'm1', 'mcp_wiki__create_page', 3)], resolveTool);
  now.advance(2000);
  const [frame] = tracker.observe([entry(0, 'm1', 'mcp_wiki__create_page', 4000)], resolveTool);
  assert.equal('occurrence' in frame.data, false);
});

// ── throttle and frame budget ───────────────────────────────────────────────

test('at most one frame per second per call, absolute values, argBytes never decreases', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  const frames = [];
  let bytes = 0;
  for (let i = 0; i < 100; i++) {
    bytes += 100;
    frames.push(...tracker.observe([entry(0, 'c', 'create_file', bytes)], resolveTool));
    now.advance(25);
  }
  // 2.5 s of fragments every 25 ms: the announcement, then one per second.
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map(f => f.data.argBytes),
    [100, 4100, 8100]
  );
  // A later report that is smaller (a provider that restates) never lowers it:
  // what the throttle held back goes out with the next frame.
  now.advance(MIN_FRAME_INTERVAL_MS);
  const [restated] = tracker.observe([entry(0, 'c', 'create_file', 50)], resolveTool);
  assert.equal(restated.data.argBytes, bytes);
  now.advance(MIN_FRAME_INTERVAL_MS);
  assert.deepEqual(
    tracker.observe([entry(0, 'c', 'create_file', 50)], resolveTool),
    [],
    'unchanged'
  );
  const [grown] = tracker.observe([entry(0, 'c', 'create_file', bytes + 1)], resolveTool);
  assert.equal(grown.data.argBytes, bytes + 1);
});

test('the announcement carries the display fields, most later frames the two numbers only, and every fifth repeats the fields', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  const frames = [];
  for (let step = 0; step < 11; step++) {
    frames.push(
      ...tracker.observe([entry(0, 'c', 'create_web_artifact', step * 1000)], resolveTool)
    );
    now.advance(MIN_FRAME_INTERVAL_MS);
  }
  assert.equal(frames.length, 11);
  assert.ok(frames[0].data.name && frames[0].data.title && frames[0].data.outputKind);
  assert.deepEqual(Object.keys(frames[1].data).sort(), ['argBytes', 'elapsedMs']);
  assert.equal(frames[1].data.elapsedMs, MIN_FRAME_INTERVAL_MS);
  const withDisplay = frames.map(f => ('outputKind' in f.data ? 1 : 0));
  assert.deepEqual(withDisplay, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // A client that attached late draws the row from a repeat.
  assert.equal(frames[5].data.name, 'create_web_artifact');
  assert.equal(frames[5].data.outputKind, 'webArtifact');
});

test('120 s of streaming stay within 130 frames and 40 KB, never more than 2 s apart, with no argument text', () => {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  const sent = [];
  const secret = 'SECRET-ARGUMENT-TEXT';
  let bytes = 0;
  for (let t = 0; t <= 120_000; t += 100) {
    bytes += 80;
    // The entry is all a converter reports: sizes, never the text.
    const frames = tracker.observe(
      [{ ...entry(0, 'call_1', 'create_web_artifact', bytes), text: secret }],
      resolveTool
    );
    for (const frame of frames) sent.push({ at: t, frame });
    now.advance(100);
  }
  for (const frame of tracker.close({
    outcome: 'completed',
    result: {
      toolCalls: [
        { id: 'call_1', index: 0, function: { name: 'create_web_artifact', arguments: '{"a":1}' } }
      ]
    }
  })) {
    sent.push({ at: 120_000, frame });
  }

  assert.ok(sent.length <= 130, `${sent.length} frames`);
  const wire = sent.map(({ frame }) =>
    JSON.stringify({
      ...buildEnvelope({
        streamId: 'chat-1',
        runId: 'chat-12345678-1234-1234-1234-123456789012',
        type: SSE_V2_EVENTS.TOOL_PROGRESS,
        data: {
          step: 1,
          callId: frame.callId,
          toolId: frame.toolId,
          phase: frame.phase,
          data: frame.data
        }
      }),
      seq: 99999
    })
  );
  const bytesOnWire = wire.reduce((sum, line) => sum + line.length + 8, 0); // `data: ` and the blank line
  assert.ok(bytesOnWire <= 40 * 1024, `${bytesOnWire} bytes`);
  assert.ok(!wire.some(line => line.includes(secret)), 'no frame carries argument text');

  const progressTimes = sent.filter(s => s.frame.phase === 'args').map(s => s.at);
  for (let i = 1; i < progressTimes.length; i++) {
    const gap = progressTimes[i] - progressTimes[i - 1];
    assert.ok(gap >= MIN_FRAME_INTERVAL_MS, `gap ${gap} is at least the throttle`);
    assert.ok(
      gap <= MAX_FRAME_GAP_MS,
      `gap ${gap} stays within the 2 s bound while fragments flow`
    );
  }
  const sizes = sent.filter(s => s.frame.phase === 'args').map(s => s.frame.data.argBytes);
  assert.deepEqual(
    sizes,
    [...sizes].sort((a, b) => a - b),
    'argBytes never decreases'
  );
  assert.equal(sent.at(-1).frame.phase, 'args.ended');
});

// ── closing: exactly one args.ended per announced call ──────────────────────

/** Announce one call and close the model call the way a test says. */
function closeWith({ outcome = 'completed', result, name = 'create_web_artifact', id = 'call_1' }) {
  const now = clock();
  const tracker = createToolArgTracker({ now });
  tracker.observe([entry(0, id, name, 120)], resolveTool);
  now.advance(2500);
  const frames = tracker.close({ outcome, result });
  assert.equal(tracker.hasOpenCalls(), false, 'nothing is left open');
  assert.deepEqual(tracker.close({ outcome, result }), [], 'closing again sends nothing');
  return frames;
}

const finished = (args, { id = 'call_1', index = 0, name = 'create_web_artifact' } = {}) => ({
  id,
  index,
  function: { name, arguments: args }
});

test('ready: the finished call exists and its arguments parse', () => {
  const [ended] = closeWith({
    result: { toolCalls: [finished('{"content":"x"}')], finishReason: 'tool_calls' }
  });
  assert.deepEqual(ended, {
    phase: 'args.ended',
    callId: 'call_1',
    toolId: 'create_web_artifact',
    data: { outcome: 'ready', argBytes: 120, elapsedMs: 2500 }
  });
});

test('ready also for empty arguments and for arguments the loop repairs', () => {
  assert.equal(closeWith({ result: { toolCalls: [finished('')] } })[0].data.outcome, 'ready');
  assert.equal(
    closeWith({ result: { toolCalls: [finished('{"a":1}{"b":2}')] } })[0].data.outcome,
    'ready'
  );
});

test('invalid: the arguments cannot be read as JSON at all', () => {
  const [ended] = closeWith({
    result: { toolCalls: [finished('no json here')], finishReason: 'tool_calls' }
  });
  assert.equal(ended.data.outcome, 'invalid');
});

test('truncated: the output limit was hit inside the arguments', () => {
  assert.equal(
    closeWith({
      result: { toolCalls: [finished('{"content":"<html><body>cut off')], finishReason: 'length' }
    })[0].data.outcome,
    'truncated'
  );
  // Anthropic never finishes the block: the call is not in the list at all.
  assert.equal(
    closeWith({ result: { toolCalls: [], finishReason: 'length' } })[0].data.outcome,
    'truncated'
  );
  // A call that parses whole is not truncated by the limit that hit a later one.
  assert.equal(
    closeWith({ result: { toolCalls: [finished('{"a":1}')], finishReason: 'length' } })[0].data
      .outcome,
    'ready'
  );
});

test('dropped: the finished list has no such call, or the loop cannot run it', () => {
  assert.equal(
    closeWith({ result: { toolCalls: [], finishReason: 'tool_calls' } })[0].data.outcome,
    'dropped'
  );
  assert.equal(
    closeWith({
      result: { toolCalls: [finished('{}', { name: '  ' })], finishReason: 'tool_calls' }
    })[0].data.outcome,
    'dropped'
  );
});

test('a provider error and Stop close every announced call as aborted', () => {
  for (const outcome of ['error', 'aborted']) {
    const [ended] = closeWith({ outcome });
    assert.equal(ended.data.outcome, 'aborted', outcome);
    assert.equal(ended.data.argBytes, 120);
  }
});

test('the call is found by id, else by index', () => {
  const byIndex = closeWith({
    result: { toolCalls: [finished('{"a":1}', { id: 'other_id', index: 0 })] }
  });
  assert.equal(byIndex[0].data.outcome, 'ready');
  const byId = closeWith({
    result: { toolCalls: [finished('{"a":1}', { id: 'call_1', index: 5 })] }
  });
  assert.equal(byId[0].data.outcome, 'ready');
});

test('every announced call gets exactly one args.ended, in the order they appeared', () => {
  const tracker = createToolArgTracker({ now: clock() });
  tracker.observe(
    [
      entry(0, 'a', 'create_file', 3),
      entry(1, 'b', 'create_web_artifact', 4),
      entry(2, 'c', 'webSearch', 1)
    ],
    resolveTool
  );
  const frames = tracker.close({
    outcome: 'completed',
    result: {
      toolCalls: [finished('{}', { id: 'a', index: 0, name: 'create_file' })],
      finishReason: 'tool_calls'
    }
  });
  assert.deepEqual(
    frames.map(f => [f.callId, f.data.outcome]),
    [
      ['a', 'ready'],
      ['b', 'dropped']
    ]
  );
});

test('argsOutcomeOf is a pure function of the call and the end of the model call', () => {
  const call = { id: 'x', index: 0 };
  assert.equal(argsOutcomeOf(call, 'error'), ARGS_OUTCOMES.ABORTED);
  assert.equal(argsOutcomeOf(call, 'completed', undefined), ARGS_OUTCOMES.DROPPED);
});

// ── the waiting line ────────────────────────────────────────────────────────

/** Fake timers for the waiting line and the seam. */
function fakeTime(t) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
}

test('the waiting line speaks after 3 s of silence, then once a second', t => {
  fakeTime(t);
  const waits = [];
  const line = createWaitingLine({ onWaiting: w => waits.push(w) });
  line.arm();
  mock.timers.tick(WAITING_AFTER_MS - 1);
  assert.deepEqual(waits, []);
  mock.timers.tick(1);
  assert.deepEqual(waits, [{ elapsedMs: 3000, reasoning: false }]);
  mock.timers.tick(1000);
  mock.timers.tick(1000);
  assert.deepEqual(
    waits.map(w => w.elapsedMs),
    [3000, 4000, 5000]
  );
  line.stop();
});

test('visible output resets the clock; the line speaks again 3 s after the last one', t => {
  fakeTime(t);
  const waits = [];
  const line = createWaitingLine({ onWaiting: w => waits.push(w.elapsedMs) });
  line.arm();
  mock.timers.tick(2000);
  line.visible();
  mock.timers.tick(2900);
  assert.deepEqual(waits, [], '4.9 s since the start, 2.9 s since the output');
  mock.timers.tick(100);
  assert.deepEqual(waits, [3000]);
  line.visible();
  mock.timers.tick(2999);
  assert.deepEqual(waits, [3000]);
  mock.timers.tick(1);
  assert.deepEqual(waits, [3000, 3000]);
  line.stop();
});

test('streamed reasoning is reported as reasoning and does not restart the clock', t => {
  fakeTime(t);
  const waits = [];
  const line = createWaitingLine({ onWaiting: w => waits.push(w) });
  line.arm();
  mock.timers.tick(1000);
  line.thinking();
  mock.timers.tick(1000);
  line.thinking();
  mock.timers.tick(1000);
  assert.deepEqual(waits, [{ elapsedMs: 3000, reasoning: true }]);
  // Answer text ends the reasoning silence.
  line.visible();
  mock.timers.tick(3000);
  assert.deepEqual(waits.at(-1), { elapsedMs: 3000, reasoning: false });
  line.stop();
});

test('the waiting line is cleared by stop() and stays silent while a row is on screen', t => {
  fakeTime(t);
  const waits = [];
  let row = true;
  const line = createWaitingLine({
    onWaiting: w => waits.push(w.elapsedMs),
    isSuppressed: () => row
  });
  line.arm();
  mock.timers.tick(10_000);
  assert.deepEqual(waits, [], 'the row owns the headline');
  row = false;
  mock.timers.tick(1000);
  assert.deepEqual(waits, [11_000]);
  line.stop();
  mock.timers.tick(60_000);
  assert.deepEqual(waits, [11_000], 'nothing after stop()');
});

test('arm() starts a new silence for the next model call', t => {
  fakeTime(t);
  const waits = [];
  const line = createWaitingLine({ onWaiting: w => waits.push(w.elapsedMs) });
  line.arm();
  for (let i = 0; i < 4; i++) mock.timers.tick(1000);
  line.stop();
  mock.timers.tick(5000);
  line.arm();
  for (let i = 0; i < 3; i++) mock.timers.tick(1000);
  assert.deepEqual(waits, [3000, 4000, 3000], 'the second call counts from its own start');
  line.stop();
});

// ── the chat seam ───────────────────────────────────────────────────────────

/** A chatToolSeam with a recording emitter and a loop context like the real one. */
function seamHarness(options = {}) {
  const emitted = [];
  const seam = chatToolSeam({
    chatId: 'chat-1',
    buildLogData: () => ({}),
    logInteraction: async () => {},
    ...options
  });
  const ctx = {
    iteration: 1,
    request: { toolExecution: 'server' },
    meta: { stream: { emit: (type, data) => emitted.push({ type, data }) } },
    resolveTool
  };
  const progress = () =>
    emitted.filter(e => e.type === SSE_V2_EVENTS.TOOL_PROGRESS).map(e => e.data);
  return { seam, ctx, emitted, progress };
}

test('the seam announces, reports and closes a call as tool/progress frames of its step', () => {
  const { seam, ctx, progress } = seamHarness();
  seam.preStep(ctx);
  seam.onChunk(ctx, {
    content: [],
    toolCallProgress: [entry(0, 'call_1', 'create_web_artifact', 0)]
  });
  seam.onChunk(ctx, {
    content: [],
    toolCallProgress: [entry(0, 'call_1', 'create_web_artifact', 700)]
  });
  seam.streamEnd(ctx, {
    outcome: 'completed',
    result: {
      finishReason: 'tool_calls',
      toolCalls: [finished('{"content":"x"}')]
    }
  });
  const frames = progress();
  assert.deepEqual(
    frames.map(f => [f.phase, f.callId, f.toolId, f.step]),
    [
      ['args', 'call_1', 'create_web_artifact', 1],
      ['args.ended', 'call_1', 'create_web_artifact', 1]
    ]
  );
  assert.equal(frames[0].data.outputKind, 'webArtifact');
  // The second chunk came within the throttle interval: the end carries the size.
  assert.equal(frames[1].data.argBytes, 700);
  assert.equal(frames[1].data.outcome, 'ready');
});

test('the seam reports nothing for a chunk without a signal and never throws into the turn', () => {
  const { seam, ctx, progress } = seamHarness();
  seam.preStep(ctx);
  seam.onChunk(ctx, { content: ['Hello'], thinking: [] });
  seam.onChunk(ctx, { content: [] });
  assert.deepEqual(progress(), []);
  const broken = {
    ...ctx,
    resolveTool: () => {
      throw new Error('lookup failed');
    }
  };
  assert.doesNotThrow(() =>
    seam.onChunk(broken, { content: [], toolCallProgress: [entry(0, 'c', 'create_file', 1)] })
  );
  seam.streamEnd(ctx, { outcome: 'aborted' });
});

test('the seam is off for a turn nobody watches live and for caller-executed tools', () => {
  for (const [options, mutate] of [
    [{ streamProgress: false }, () => {}],
    [{}, ctx => (ctx.request.toolExecution = 'caller')],
    [{}, ctx => (ctx.meta.stream = null)]
  ]) {
    const { seam, ctx, emitted } = seamHarness(options);
    mutate(ctx);
    seam.preStep(ctx);
    seam.onChunk(ctx, { content: [], toolCallProgress: [entry(0, 'c', 'create_file', 1)] });
    seam.streamEnd(ctx, { outcome: 'completed', result: { toolCalls: [] } });
    assert.deepEqual(emitted, []);
  }
});

test('the seam speaks the waiting line, resets it on text, and clears it at streamEnd', t => {
  fakeTime(t);
  const { seam, ctx, progress } = seamHarness();
  seam.preStep(ctx);
  mock.timers.tick(2000);
  seam.onChunk(ctx, { content: ['Hello'] });
  mock.timers.tick(2999);
  assert.deepEqual(progress(), []);
  mock.timers.tick(1);
  assert.deepEqual(progress(), [{ step: 1, phase: 'model.waiting', data: { elapsedMs: 3000 } }]);
  mock.timers.tick(1000);
  assert.equal(progress().length, 2);
  seam.streamEnd(ctx, { outcome: 'completed', result: { toolCalls: [] } });
  mock.timers.tick(60_000);
  assert.equal(progress().length, 2, 'nothing after the model call ended');
});

test('model.waiting says reasoning when the model streamed reasoning during the silence', t => {
  fakeTime(t);
  const { seam, ctx, progress } = seamHarness();
  seam.preStep(ctx);
  mock.timers.tick(1000);
  seam.onChunk(ctx, { content: [], thinking: [{ content: 'Let me think' }] });
  mock.timers.tick(2000);
  assert.deepEqual(progress(), [
    { step: 1, phase: 'model.waiting', data: { elapsedMs: 3000, reasoning: true } }
  ]);
  seam.onChunk(ctx, { content: ['Answer'] });
  mock.timers.tick(3000);
  assert.deepEqual(progress().at(-1).data, { elapsedMs: 3000 });
  seam.streamEnd(ctx, { outcome: 'completed', result: { toolCalls: [] } });
});

test('an announced row silences the waiting line until the call is closed', t => {
  fakeTime(t);
  const { seam, ctx, progress } = seamHarness();
  seam.preStep(ctx);
  mock.timers.tick(1500);
  seam.onChunk(ctx, { content: [], toolCallProgress: [entry(0, 'c1', 'create_file', 0)] });
  mock.timers.tick(20_000);
  assert.deepEqual(
    progress().map(p => p.phase),
    ['args'],
    'no waiting frame while the row is open, however long the arguments stall'
  );
  seam.streamEnd(ctx, { outcome: 'aborted' });
  assert.deepEqual(
    progress().map(p => p.phase),
    ['args', 'args.ended']
  );
  mock.timers.tick(20_000);
  assert.equal(progress().length, 2);
});

test('each model call of a turn is armed again by its preStep', t => {
  fakeTime(t);
  const { seam, ctx, progress } = seamHarness();
  seam.preStep(ctx);
  mock.timers.tick(3000);
  seam.streamEnd(ctx, { outcome: 'completed', result: { toolCalls: [] } });
  ctx.iteration = 2;
  seam.preStep(ctx);
  mock.timers.tick(3000);
  seam.streamEnd(ctx, { outcome: 'completed', result: { toolCalls: [] } });
  assert.deepEqual(
    progress().map(p => [p.step, p.phase, p.data.elapsedMs]),
    [
      [1, 'model.waiting', 3000],
      [2, 'model.waiting', 3000]
    ]
  );
});

test('the phase names are the documented ones', () => {
  assert.deepEqual(PROGRESS_PHASES, {
    ARGS: 'args',
    ARGS_ENDED: 'args.ended',
    MODEL_WAITING: 'model.waiting'
  });
});
