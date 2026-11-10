// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool-call progress on the chat wire, end to end (issue #3534): the real
 * `ChatService.runTurn` on the real `AgentLoop` and converters with a scripted
 * OpenAI-wire provider.
 *
 * What the frames promise:
 *  - a creator tool is announced (`tool/progress` phase `args`) as soon as its
 *    name and id are known, under the call id `tool/started` will carry, and
 *    closed (`args.ended`) before that `tool/started`;
 *  - exactly one `args.ended` per announced call, also when the provider fails
 *    or the user presses Stop in the middle of the arguments (the loop returns
 *    from its `catch` there without `stepEnd`);
 *  - a call taken over by the approval gate is closed `ready` and never started;
 *  - no frame of the feature carries argument text, and `tool/started` and
 *    everything stored are the same as without it.
 */
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ChatService from '../../services/chat/ChatService.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { markInteractiveTools } from '../../services/loop/seams/questionSeam.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import { RunLog } from '../../services/loop/RunLog.js';
import { setEnvelopeDelivery, stampSeq } from '../../services/loop/RunStream.js';
import { sseV2EventSchema } from '../../services/loop/contracts/sseV2.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { activeRequests, routeEnvelope } from '../../sse.js';
import { startTestStorage } from '../helpers/testStorage.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';
import { fakeResponse, makeClient, sseResponse, MODELS } from './helpers/llmFixtures.js';

const storage = await startTestStorage({ prefix: 'chat-tool-progress-' });
after(async () => {
  await storage.stop();
});

const {
  INTERACTION_RAISED,
  RUN_ENDED,
  RUN_PAUSED,
  STEP_COMPLETED,
  STREAM_ERROR,
  TOOL_COMPLETED,
  TOOL_PROGRESS,
  TOOL_STARTED
} = SSE_V2_EVENTS;

const SECRET = 'SECRETMARKER-ARGUMENT-TEXT';

// ── frames ──────────────────────────────────────────────────────────────────

const sinks = new Map();
test.before(() => {
  setEnvelopeDelivery((streamId, envelope) => {
    sinks.get(streamId)?.push(stampSeq(streamId, envelope));
  });
});
test.after(() => setEnvelopeDelivery(routeEnvelope));

function captureFrames(t, chatId) {
  const frames = [];
  sinks.set(chatId, frames);
  t.after(() => sinks.delete(chatId));
  return frames;
}

const ofType = (frames, type) => frames.filter(f => f.type === type);
const phases = (frames, phase) => ofType(frames, TOOL_PROGRESS).filter(f => f.data.phase === phase);
const typesOf = frames =>
  frames.map(f => (f.type === TOOL_PROGRESS ? `progress:${f.data.phase}` : f.type));

function assertWellFormed(frames) {
  for (const envelope of frames) {
    const verdict = sseV2EventSchema.safeParse(envelope);
    assert.ok(verdict.success, `invalid envelope ${envelope.type}: ${verdict.error?.message}`);
  }
}

// ── scripted provider (OpenAI wire) ─────────────────────────────────────────

const delta = (toolCalls, finish = null) => ({
  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finish }]
});
const callStart = (index, id, name, args = '') =>
  delta([{ index, id, type: 'function', function: { name, arguments: args } }]);
const callFragment = (index, args) => delta([{ index, function: { arguments: args } }]);
const finishWith = reason => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const textDelta = content => ({
  choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
});

/** One model turn that calls `name` with arguments streamed in fragments. */
function streamedCall(name, fragments, { id = 'call_1', finish = 'tool_calls' } = {}) {
  return [
    callStart(0, id, name),
    ...fragments.map(f => callFragment(0, f)),
    finishWith(finish),
    '[DONE]'
  ];
}

const finalAnswer = [textDelta('Done.'), finishWith('stop'), '[DONE]'];

const CONTENT = `{"filename":"a.html","content":"${SECRET}<p>`;
const FRAGMENTS = [CONTENT, 'second fragment ', 'third fragment</p>"}'];

// ── the service ─────────────────────────────────────────────────────────────

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

function makeService(turns, { interactionService, runTool } = {}) {
  const script = [...turns];
  const { client } = makeClient({
    maxRetries: 0,
    transport: async (request, ctx) => {
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (typeof next === 'function') return next(request, ctx);
      return sseResponse(next);
    }
  });
  const runToolSpy = spy(runTool || (async () => ({ ok: true })));
  const service = new ChatService({
    agentLoop: new AgentLoop({ llmClient: client, logger: silentLogger }),
    logInteraction: spy(async () => {}),
    runTool: runToolSpy,
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} },
    runLog: { startRun: async () => ({}), endRun: () => {} },
    ...(interactionService ? { interactionService } : {})
  });
  return { service, runTool: runToolSpy };
}

const CREATE_WEB_ARTIFACT = {
  id: 'create_web_artifact',
  name: 'Create interactive web artifact',
  description: 'Create a web artifact',
  isSystemSkillTool: true,
  outputKind: 'webArtifact',
  parameters: {
    type: 'object',
    properties: { filename: { type: 'string' }, content: { type: 'string' } }
  }
};
const CREATE_FILE = {
  id: 'create_file',
  name: 'Create file',
  description: 'Create a file',
  isSystemSkillTool: true,
  outputKind: 'file',
  parameters: { type: 'object', properties: { content: { type: 'string' } } }
};
const WIKI_TOOL = {
  id: 'mcp_wiki__create_page',
  name: 'mcp_wiki__create_page',
  description: 'Create a wiki page',
  _mcp: { serverId: 'wiki', serverName: 'Wiki', originalName: 'create_page' },
  parameters: { type: 'object', properties: { body: { type: 'string' } } }
};
const ASK_USER = {
  id: 'ask_user',
  name: 'ask_user',
  description: 'ask',
  parameters: { type: 'object', properties: { question: { type: 'string' } } }
};
const SKILL_TOOL = {
  id: 'activate_skill',
  name: 'Activate Skill',
  description: 'skill',
  isInternalTool: true,
  parameters: { type: 'object', properties: { skill_name: { type: 'string' } } }
};

function prep(tools, overrides = {}) {
  return {
    app: { id: 'app1' },
    model: MODELS.openai,
    llmMessages: [{ role: 'user', content: 'Build me a calculator' }],
    tools: markInteractiveTools(tools),
    maxTokens: 512,
    llmOptions: {},
    ...overrides
  };
}

const newChatId = label => `chat-progress-${label}-${crypto.randomUUID().slice(0, 8)}`;

function turn(service, { chatId, prepData, ...rest }) {
  return service.runTurn({
    prep: prepData,
    chatId,
    streaming: true,
    buildLogData: () => ({}),
    language: 'en',
    user: { id: 'u1', groups: ['users'] },
    getLocalizedError: async () => null,
    ...rest
  });
}

/** An SSE body the test feeds by hand; errors with an AbortError when the request is aborted. */
function heldBody(signal) {
  let controller;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      controller = c;
      signal?.addEventListener('abort', () => {
        try {
          c.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          /* already closed */
        }
      });
    }
  });
  return {
    body,
    push: event =>
      controller.enqueue(
        encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
      ),
    close: () => controller.close()
  };
}

const heldResponse = held =>
  fakeResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    body: held.body,
    text: ''
  });

const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
};

// ── announced, closed, started ──────────────────────────────────────────────

test('a creator tool is announced under its call id, closed before tool/started, and nothing leaks', async t => {
  const chatId = newChatId('creator');
  const frames = captureFrames(t, chatId);
  const { service, runTool } = makeService([
    streamedCall('create_web_artifact', FRAGMENTS),
    finalAnswer
  ]);

  const summary = await turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });

  assert.equal(summary.status, 'completed');
  assertWellFormed(frames);
  assert.equal(runTool.calls.length, 1, 'the tool still runs, once');

  const [announced, ...rest] = phases(frames, 'args');
  assert.equal(announced.data.callId, 'call_1');
  assert.equal(announced.data.toolId, 'create_web_artifact');
  assert.equal(announced.data.step, 1);
  assert.deepEqual(
    { ...announced.data.data, argBytes: 'n', elapsedMs: 'n' },
    {
      name: 'create_web_artifact',
      title: 'Create interactive web artifact',
      activityKind: 'tool',
      outputKind: 'webArtifact',
      argBytes: 'n',
      elapsedMs: 'n'
    }
  );
  assert.equal('occurrence' in announced.data.data, false, 'the first call has none');
  for (const later of rest) {
    assert.deepEqual(Object.keys(later.data.data).sort(), ['argBytes', 'elapsedMs']);
  }

  const [ended, ...extraEnds] = phases(frames, 'args.ended');
  assert.equal(extraEnds.length, 0, 'exactly one args.ended per announced call');
  assert.equal(ended.data.callId, 'call_1');
  assert.equal(ended.data.data.outcome, 'ready');
  assert.equal(ended.data.data.argBytes, Buffer.byteLength(FRAGMENTS.join(''), 'utf8'));

  const started = ofType(frames, TOOL_STARTED);
  assert.equal(started.length, 1);
  assert.equal(started[0].data.callId, announced.data.callId, 'the call id is stable');
  assert.equal(ofType(frames, TOOL_COMPLETED)[0].data.callId, announced.data.callId);
  assert.ok(
    frames.indexOf(announced) < frames.indexOf(ended) &&
      frames.indexOf(ended) < frames.indexOf(started[0]),
    'announced, then closed, then started'
  );
  assert.ok(
    frames.indexOf(ended) < frames.indexOf(ofType(frames, STEP_COMPLETED)[0]),
    'closed before the step ends'
  );

  // tool/started is what it was before: the kind rides on the progress frames only.
  assert.equal('outputKind' in started[0].data, false);
  assert.equal(started[0].data.title, 'Create interactive web artifact');

  const wire = JSON.stringify(ofType(frames, TOOL_PROGRESS));
  assert.ok(!wire.includes(SECRET), 'no frame of the feature carries argument text');
  assert.ok(!wire.includes('second fragment'));
});

test('the second call of a tool in a turn is announced with occurrence 2', async t => {
  const chatId = newChatId('occurrence');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([
    streamedCall('create_web_artifact', FRAGMENTS, { id: 'call_1' }),
    streamedCall('create_web_artifact', FRAGMENTS, { id: 'call_2' }),
    finalAnswer
  ]);
  await turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });

  const announced = phases(frames, 'args').filter(f => f.data.data.name);
  assert.deepEqual(
    announced.map(f => [f.data.callId, f.data.step, f.data.data.occurrence]),
    [
      ['call_1', 1, undefined],
      ['call_2', 2, 2]
    ]
  );
  assert.equal(phases(frames, 'args.ended').length, 2);
  assert.deepEqual(
    ofType(frames, TOOL_STARTED).map(f => f.data.callId),
    ['call_1', 'call_2']
  );
});

test('the order of everything in a creator turn', async t => {
  const chatId = newChatId('order');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([streamedCall('create_file', ['{"content":"x"}']), finalAnswer]);
  await turn(service, { chatId, prepData: prep([CREATE_FILE]) });
  assert.deepEqual(typesOf(frames).slice(0, 6), [
    'run/started',
    'progress:args',
    'progress:args.ended',
    'step/completed',
    'tool/started',
    'tool/completed'
  ]);
});

// ── which calls are announced ───────────────────────────────────────────────

test('ask_user, a loop tool and a hallucinated name produce no progress frame at all', async t => {
  for (const [label, name, tools] of [
    ['ask_user', 'ask_user', [ASK_USER]],
    ['activate_skill', 'activate_skill', [SKILL_TOOL]],
    ['hallucinated', 'no_such_tool', [CREATE_FILE]]
  ]) {
    const chatId = newChatId(label);
    const frames = captureFrames(t, chatId);
    const { service } = makeService([streamedCall(name, ['{"question":"?"', '}']), finalAnswer]);
    await turn(service, { chatId, prepData: prep(tools) });
    assert.deepEqual(ofType(frames, TOOL_PROGRESS), [], label);
  }
});

test('a tool whose call arrives whole (a buffering parser) leaves the frames as they were', async t => {
  const chatId = newChatId('buffered');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([
    [
      callStart(0, 'call_1', 'create_web_artifact', FRAGMENTS.join('')),
      finishWith('tool_calls'),
      '[DONE]'
    ],
    finalAnswer
  ]);
  const summary = await turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });
  assert.equal(summary.status, 'completed');
  assert.deepEqual(ofType(frames, TOOL_PROGRESS), [], 'no early signal, no frame');
  assert.equal(ofType(frames, TOOL_STARTED).length, 1);
});

test('another tool is announced only when its arguments keep streaming past 1.5 s; a fast one never', async t => {
  mock.timers.enable({ apis: ['Date'] });
  t.after(() => mock.timers.reset());
  const chatId = newChatId('deferred');
  const frames = captureFrames(t, chatId);
  const slow = heldBody();
  const { service } = makeService([() => heldResponse(slow), finalAnswer]);
  const running = turn(service, { chatId, prepData: prep([WIKI_TOOL]) });

  slow.push(callStart(0, 'call_w', 'mcp_wiki__create_page'));
  slow.push(callFragment(0, '{"body":"first part'));
  await settle();
  assert.deepEqual(phases(frames, 'args'), [], 'a fast call would end here: no row yet');
  mock.timers.tick(1600);
  slow.push(callFragment(0, ' and more'));
  await settle();
  const [announced] = phases(frames, 'args');
  assert.equal(announced.data.callId, 'call_w');
  assert.equal(announced.data.data.title, 'create_page');
  assert.equal(announced.data.data.integration, 'Wiki');
  assert.ok(announced.data.data.argBytes > 0);
  slow.push(callFragment(0, '"}'));
  slow.push(finishWith('tool_calls'));
  slow.push('[DONE]');
  slow.close();
  await running;
  assert.equal(phases(frames, 'args.ended').length, 1);
});

// ── closing ─────────────────────────────────────────────────────────────────

test('a provider error in the middle of the arguments closes the call as aborted, before stream/error', async t => {
  const chatId = newChatId('error');
  const frames = captureFrames(t, chatId);
  const { service, runTool } = makeService([
    [
      callStart(0, 'call_1', 'create_web_artifact'),
      callFragment(0, CONTENT),
      { error: { message: 'upstream failed' } }
    ]
  ]);
  const summary = await turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });

  assert.equal(summary.status, 'error');
  assert.equal(runTool.calls.length, 0);
  assertWellFormed(frames);
  const ended = phases(frames, 'args.ended');
  assert.equal(ended.length, 1, 'exactly one');
  assert.equal(ended[0].data.data.outcome, 'aborted');
  assert.equal(ended[0].data.callId, 'call_1');
  assert.ok(ended[0].data.data.argBytes > 0);
  const endedAt = frames.indexOf(ended[0]);
  assert.ok(endedAt < frames.indexOf(ofType(frames, STREAM_ERROR)[0]));
  assert.ok(endedAt < frames.indexOf(ofType(frames, RUN_ENDED)[0]));
  assert.equal(ofType(frames, TOOL_STARTED).length, 0);
});

test('Stop in the middle of the arguments closes the call as aborted before run/ended', async t => {
  const chatId = newChatId('stop');
  const frames = captureFrames(t, chatId);
  const held = {};
  const { service } = makeService([
    (request, ctx) => {
      held.value = heldBody(ctx.signal);
      return heldResponse(held.value);
    }
  ]);
  const running = turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });
  while (!held.value) await settle(1);
  held.value.push(callStart(0, 'call_1', 'create_web_artifact'));
  held.value.push(callFragment(0, CONTENT));
  await settle();
  assert.equal(phases(frames, 'args').length >= 1, true, 'the row is announced');
  activeRequests.get(chatId).abort();
  const summary = await running;

  assert.equal(summary.status, 'aborted');
  const ended = phases(frames, 'args.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.data.outcome, 'aborted');
  assert.ok(frames.indexOf(ended[0]) < frames.indexOf(ofType(frames, RUN_ENDED)[0]));
  assert.equal(ofType(frames, TOOL_STARTED).length, 0);
});

test('output cut off by the limit: args.ended truncated, then the loop still runs the call it could read', async t => {
  const chatId = newChatId('truncated');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([
    streamedCall('create_web_artifact', ['{"filename":"a.html","content":"<html><body>cut'], {
      finish: 'length'
    }),
    finalAnswer
  ]);
  await turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });
  assert.equal(phases(frames, 'args.ended')[0].data.data.outcome, 'truncated');
  // The loop repairs what it can and runs the call: a tool/started for the same id follows.
  const started = ofType(frames, TOOL_STARTED);
  assert.equal(started.length, 1);
  assert.equal(started[0].data.callId, 'call_1');
});

test('arguments that are not JSON: args.ended invalid', async t => {
  const chatId = newChatId('invalid');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([
    streamedCall('create_web_artifact', ['this is ', 'not json']),
    finalAnswer
  ]);
  await turn(service, { chatId, prepData: prep([CREATE_WEB_ARTIFACT]) });
  assert.equal(phases(frames, 'args.ended')[0].data.data.outcome, 'invalid');
});

// ── approval ────────────────────────────────────────────────────────────────

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function chatStore(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-progress-chats-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: silent
  });
  t.after(async () => {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return repository;
}

test('a call the approval gate takes over is closed ready, never started, and the card names the same call id', async t => {
  const chatId = newChatId('approval');
  const frames = captureFrames(t, chatId);
  const repository = await chatStore(t);
  const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
  const interactionService = new InteractionService({ runLog });
  t.after(async () => interactionService.stop?.());
  const gated = {
    ...CREATE_WEB_ARTIFACT,
    approval: 'always',
    approvalSource: 'tool',
    sideEffect: 'write',
    sideEffectSource: 'tool',
    dataFlow: 'external'
  };
  const { service, runTool } = makeService(
    [streamedCall('create_web_artifact', FRAGMENTS, { id: 'call_gate' })],
    { interactionService }
  );

  const summary = await turn(service, {
    chatId,
    prepData: prep([gated]),
    persistence: {
      repository,
      ownerId: 'u1',
      identityMode: 'default',
      content: 'Build me a calculator'
    }
  });

  assert.equal(summary.status, 'paused');
  assert.equal(summary.finishReason, 'approval');
  assert.equal(runTool.calls.length, 0);
  assert.equal(ofType(frames, TOOL_STARTED).length, 0, 'a gated call is never started');

  const announced = phases(frames, 'args')[0];
  const ended = phases(frames, 'args.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.data.outcome, 'ready');
  const [raised] = ofType(frames, INTERACTION_RAISED);
  assert.equal(raised.data.interaction.source.toolCallId, announced.data.callId);
  assert.equal(raised.data.interaction.source.toolId, announced.data.toolId);
  assert.ok(
    frames.indexOf(ended[0]) < frames.indexOf(raised) &&
      frames.indexOf(raised) < frames.indexOf(ofType(frames, RUN_PAUSED)[0]),
    'closed ready, then the card, then the pause'
  );
});

// ── the waiting line ────────────────────────────────────────────────────────

test('a silent provider gets model.waiting after 3 s, once a second, until text arrives; nothing after the run', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const chatId = newChatId('waiting');
  const frames = captureFrames(t, chatId);
  const held = heldBody();
  const { service } = makeService([() => heldResponse(held)]);
  const running = turn(service, { chatId, prepData: prep([]) });
  await settle();

  for (let second = 1; second <= 5; second++) {
    mock.timers.tick(1000);
    await settle(2);
  }
  const waits = phases(frames, 'model.waiting');
  assert.deepEqual(
    waits.map(f => [f.data.step, f.data.data.elapsedMs]),
    [
      [1, 3000],
      [1, 4000],
      [1, 5000]
    ]
  );
  assert.equal('reasoning' in waits[0].data.data, false);

  held.push(textDelta('Hello'));
  held.push(finishWith('stop'));
  held.push('[DONE]');
  held.close();
  await settle();
  const summary = await running;
  assert.equal(summary.status, 'completed');
  const count = phases(frames, 'model.waiting').length;
  for (let second = 1; second <= 10; second++) {
    mock.timers.tick(1000);
    await settle(1);
  }
  assert.equal(
    phases(frames, 'model.waiting').length,
    count,
    'cleared at the end of the model call: nothing arrives after run/ended'
  );
  assertWellFormed(frames);
});

test('a provider that streams hidden reasoning is reported as reasoning during the silence', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const chatId = newChatId('reasoning');
  const frames = captureFrames(t, chatId);
  const held = heldBody();
  const { service } = makeService([() => heldResponse(held)]);
  const running = turn(service, { chatId, prepData: prep([]) });
  await settle();
  held.push({
    choices: [
      { index: 0, delta: { reasoning_content: 'Let me think about it' }, finish_reason: null }
    ]
  });
  await settle();
  for (let second = 1; second <= 3; second++) {
    mock.timers.tick(1000);
    await settle(2);
  }
  const [wait] = phases(frames, 'model.waiting');
  assert.equal(wait.data.data.reasoning, true);
  held.push(textDelta('Answer'));
  held.push(finishWith('stop'));
  held.push('[DONE]');
  held.close();
  await running;
});
