/**
 * Chat turn specs — `ChatService.runTurn` on the shared agent loop, SSE v2.
 *
 * Pins the chat wire dialect as SSE v2 envelopes (`run/started`, `step/delta`,
 * `step/completed`, `tool/started`, `tool/completed`, `tool/progress`,
 * `interaction/raised`, `run/paused`, `stream/error`, `run/ended`), the run
 * ledger start/end per turn, the interaction log, the per-call usage
 * telemetry, the clarification counter and the knowledge-source badge (now
 * `run/ended.knowledgeSources`) for every terminal path of a turn.
 *
 * Driven like agentLoop.test.js: the real `AgentLoop` + `LLMClient` with a
 * scripted OpenAI-wire transport (no network), a `ChatService` whose
 * collaborators (tool runner, interaction logger, telemetry, run ledger) are
 * spies, and envelopes captured by replacing the RunStream delivery function
 * (`setEnvelopeDelivery`) — the same seam `server/sse.js` installs itself on.
 *
 * How to read a spec: `types(frames)` is the ordered list of envelope types
 * for the chat's stream; `frame(frames, type)` is the first envelope of that
 * type; `assertWellFormed` checks every envelope against the v2 contract
 * (`sseV2EventSchema`), a strictly increasing `seq` and the turn's `runId`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ChatService from '../../services/chat/ChatService.js';
import { markInteractiveTools } from '../../services/loop/seams/questionSeam.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { setEnvelopeDelivery, stampSeq } from '../../services/loop/RunStream.js';
import { sseV2EventSchema } from '../../services/loop/contracts/sseV2.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { activeRequests, routeEnvelope } from '../../sse.js';
import PromptService from '../../services/PromptService.js';
import { LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import {
  makeClient,
  sseResponse,
  textResponse,
  openaiText,
  MODELS
} from './helpers/llmFixtures.js';

const {
  RUN_STARTED,
  RUN_ENDED,
  RUN_PAUSED,
  STEP_DELTA,
  STEP_COMPLETED,
  TOOL_STARTED,
  TOOL_PROGRESS,
  TOOL_COMPLETED,
  INTERACTION_RAISED,
  STREAM_ERROR
} = SSE_V2_EVENTS;

const RUN_ID_RE = /^chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── envelope capture ────────────────────────────────────────────────────────

/** streamId (chatId) → the frames array of the test that owns it. */
const sinks = new Map();

test.before(() => {
  // Like server/sse.js, the delivering side owns the stream sequence.
  setEnvelopeDelivery((streamId, envelope) => {
    sinks.get(streamId)?.push(stampSeq(streamId, envelope));
  });
});

test.after(() => {
  setEnvelopeDelivery(routeEnvelope);
});

/** Capture every envelope delivered for one chatId; the sink is removed after the test. */
function captureFrames(t, chatId) {
  const frames = [];
  sinks.set(chatId, frames);
  t.after(() => sinks.delete(chatId));
  return frames;
}

const types = frames => frames.map(f => f.type);
const frame = (frames, type) => frames.find(f => f.type === type);
const framesOf = (frames, type) => frames.filter(f => f.type === type);
const has = (frames, type) => frames.some(f => f.type === type);

/**
 * Every captured envelope is a valid v2 envelope for this run, and `seq` is
 * strictly increasing on the stream.
 */
function assertWellFormed(frames, { runId } = {}) {
  let prevSeq = 0;
  for (const envelope of frames) {
    const verdict = sseV2EventSchema.safeParse(envelope);
    assert.ok(
      verdict.success,
      `invalid v2 envelope ${envelope.type}: ${JSON.stringify(verdict.error?.issues)}`
    );
    assert.equal(envelope.v, 2);
    assert.ok(Number.isInteger(envelope.seq) && envelope.seq > prevSeq, 'seq strictly increasing');
    prevSeq = envelope.seq;
    assert.ok(!Number.isNaN(Date.parse(envelope.ts)), 'ts is an ISO timestamp');
    if (runId) assert.equal(envelope.runId, runId, `envelope ${envelope.type} belongs to the run`);
  }
}

// ── scripted provider turns (OpenAI wire) ───────────────────────────────────

function textTurn(content, { usage, finishReason = 'stop' } = {}) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    ...(content ? [{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }] : []),
    {
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    },
    '[DONE]'
  ];
}

function toolTurn(calls, { content = '', usage } = {}) {
  return [
    ...(content
      ? [{ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }]
      : []),
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id || `call_${i + 1}`,
              type: 'function',
              function: {
                name: c.name,
                arguments:
                  c.args === undefined
                    ? '{}'
                    : typeof c.args === 'string'
                      ? c.args
                      : JSON.stringify(c.args)
              }
            }))
          },
          finish_reason: null
        }
      ]
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      ...(usage ? { usage } : {})
    },
    '[DONE]'
  ];
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/** Build a loop whose provider answers with the scripted turns in order. */
function makeLoop(turns, { maxRetries = 0 } = {}) {
  const script = [...turns];
  const requests = [];
  const { client } = makeClient({
    maxRetries,
    transport: async (request, ctx) => {
      requests.push({ request, ctx });
      const next = script.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      if (typeof next === 'function') return next(request, ctx);
      return sseResponse(next);
    }
  });
  const loop = new AgentLoop({ llmClient: client, logger: silentLogger() });
  return { loop, requests };
}

// ── spies and service factory ───────────────────────────────────────────────

/** Minimal call-recording spy: `fn.calls` is the list of argument arrays. */
function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

/** Run ledger stub: records `startRun` / `endRun` calls, persists nothing. */
function stubRunLog() {
  return { startRun: spy(async () => ({})), endRun: spy(() => {}) };
}

/**
 * A ChatService wired to a scripted loop. Never touches the real toolLoader,
 * usage tracker, interaction log or run ledger.
 */
function makeService(turns, { runTool, maxRetries = 0, interactionService } = {}) {
  const { loop, requests } = makeLoop(turns, { maxRetries });
  const logInteraction = spy(async () => {});
  const telemetry = {
    recordChatCallStart: spy(async () => ({ promptTokens: 0 })),
    recordChatCallEnd: spy(async () => {})
  };
  const runToolSpy = spy(runTool || (async () => ({ ok: true })));
  const runLog = stubRunLog();
  const service = new ChatService({
    agentLoop: loop,
    logInteraction,
    runTool: runToolSpy,
    telemetry,
    runLog,
    ...(interactionService ? { interactionService } : {})
  });
  return { service, requests, logInteraction, telemetry, runTool: runToolSpy, runLog };
}

const USER = { id: 'u1', groups: ['users'] };

function newChatId(label) {
  return `chat-turn-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

const logTypes = logInteraction => logInteraction.calls.map(([type]) => type);
const endOutcomes = telemetry => telemetry.recordChatCallEnd.calls.map(([p]) => p.outcome);

/** `prepareChatRequest().data` built by hand (prepareChatRequest itself needs config). */
function makePrep(overrides = {}) {
  return {
    app: { id: 'app1' },
    model: MODELS.openai,
    llmMessages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    temperature: 0.7,
    maxTokens: 512,
    responseFormat: undefined,
    responseSchema: undefined,
    llmOptions: {},
    userFileData: null,
    ...overrides
  };
}

function baseLogFor(chatId, streaming = true) {
  return { appId: 'app1', user: { id: 'u1' }, userSessionId: 'sess', sessionId: chatId, streaming };
}

function runTurn(
  service,
  { chatId, prep, streaming = true, getLocalizedError, messageId, activatedSkill, runId }
) {
  const buildLogData = (isStreaming, extra = {}) => ({
    ...baseLogFor(chatId, isStreaming),
    ...extra
  });
  return service.runTurn({
    prep,
    chatId,
    ...(messageId ? { messageId } : {}),
    ...(activatedSkill ? { activatedSkill } : {}),
    ...(runId ? { runId } : {}),
    streaming,
    buildLogData,
    language: 'en',
    user: USER,
    getLocalizedError: getLocalizedError || (async () => null)
  });
}

/**
 * The ledger is opened and closed exactly once per turn, for the run the
 * frames and the summary carry.
 */
function assertLedger(runLog, summary, { status, finishReason, errorCode } = {}) {
  assert.equal(runLog.startRun.calls.length, 1, 'startRun once per turn');
  const [start] = runLog.startRun.calls[0];
  assert.equal(start.runId, summary.runId);
  assert.equal(start.kind, 'chat');
  assert.equal(start.user, USER);
  assert.equal(start.model, MODELS.openai.id);
  assert.equal(start.language, 'en');

  assert.equal(runLog.endRun.calls.length, 1, 'endRun once per turn');
  const [endRunId, end] = runLog.endRun.calls[0];
  assert.equal(endRunId, summary.runId);
  assert.equal(end.status, status ?? summary.status);
  assert.equal(end.finishReason, finishReason ?? summary.finishReason);
  assert.ok(Number.isInteger(end.durationMs) && end.durationMs >= 0);
  if (errorCode) assert.equal(end.error.code, errorCode);
  else assert.equal(end.error, undefined);
}

// ── tool definitions ────────────────────────────────────────────────────────

const webSearchTool = {
  id: 'webSearch',
  name: 'webSearch',
  description: 'search the web',
  parameters: { type: 'object', properties: { query: { type: 'string' } } }
};
const fetchTool = {
  id: 'webContentExtractor',
  name: 'webContentExtractor',
  description: 'fetch a page',
  parameters: { type: 'object', properties: { url: { type: 'string' } } }
};
const askUserTool = {
  id: 'ask_user',
  name: 'ask_user',
  description: 'ask the user',
  parameters: { type: 'object', properties: { question: { type: 'string' } } }
};
const workflowTool = {
  id: 'workflow_x',
  name: 'workflow_x',
  passthrough: true,
  description: 'workflow',
  parameters: { type: 'object', properties: { topic: { type: 'string' } } }
};

// ── 1. plain streaming turn ─────────────────────────────────────────────────

test('no tools, streaming: run/started → step/delta×2 → step/completed → run/ended{stop}; ledger, log + telemetry once each', async t => {
  const chatId = newChatId('plain');
  const frames = captureFrames(t, chatId);
  const { service, requests, logInteraction, telemetry, runLog } = makeService([
    openaiText(['Hello', ' there'])
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep(), messageId: 'msg-1' });

  assert.match(summary.runId, RUN_ID_RE, 'runTurn mints a chat run id');
  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [RUN_STARTED, STEP_DELTA, STEP_DELTA, STEP_COMPLETED, RUN_ENDED]);
  assert.equal(frames[0].seq, 1, 'a fresh stream starts at seq 1');

  assert.deepEqual(frames[0].data, {
    kind: 'chat',
    model: MODELS.openai.id,
    refs: { chatId, appId: 'app1', messageId: 'msg-1' }
  });
  assert.deepEqual(
    framesOf(frames, STEP_DELTA).map(f => f.data),
    [
      { step: 1, kind: 'text', content: 'Hello' },
      { step: 1, kind: 'text', content: ' there' }
    ]
  );
  const completed = frame(frames, STEP_COMPLETED).data;
  assert.equal(completed.step, 1);
  assert.equal(completed.content, 'Hello there');
  assert.deepEqual(completed.toolCalls, []);
  assert.equal(completed.finishReason, 'stop');
  assert.deepEqual(completed.sources, []);

  const ended = frame(frames, RUN_ENDED).data;
  assert.equal(ended.status, 'completed');
  assert.equal(ended.finishReason, 'stop');
  assert.deepEqual(ended.knowledgeSources, [], 'no badge without a source');
  assert.equal(ended.toolName, undefined);
  assert.equal(ended.error, undefined);
  assert.equal(ended.usage.source, 'estimate', 'no provider usage on the wire → estimated');
  assert.equal(ended.usage.totalTokens, ended.usage.promptTokens + ended.usage.completionTokens);
  assert.equal(has(frames, STREAM_ERROR), false);
  assert.equal(has(frames, TOOL_PROGRESS), false, 'no skill activation without a skill');

  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'Hello there');
  assert.equal(summary.finishReason, 'stop');
  assert.deepEqual(summary.knowledgeSources, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.body.tools, undefined, 'no tools offered');

  assertLedger(runLog, summary);
  assert.deepEqual(runLog.startRun.calls[0][0].refs, { chatId, appId: 'app1', messageId: 'msg-1' });
  assert.deepEqual(runLog.endRun.calls[0][1].usage, ended.usage);

  assert.deepEqual(logTypes(logInteraction), ['chat_response']);
  const [, logData] = logInteraction.calls[0];
  assert.equal(logData.responseType, 'success');
  assert.equal(logData.response, 'Hello there');
  assert.equal(logData.sessionId, chatId);
  assert.equal(logData.streaming, true);

  assert.equal(telemetry.recordChatCallStart.calls.length, 1);
  const [startArgs] = telemetry.recordChatCallStart.calls[0];
  assert.equal(startArgs.chatId, chatId);
  assert.equal(startArgs.model, MODELS.openai);
  assert.deepEqual(startArgs.baseLog, baseLogFor(chatId));
  assert.equal(startArgs.messages.length, 1);
  assert.deepEqual(endOutcomes(telemetry), ['completed']);
  assert.equal(telemetry.recordChatCallEnd.calls[0][0].content, 'Hello there');
  assert.equal(activeRequests.has(chatId), false, 'in-flight controller released');
});

test('run id: a caller-supplied ledger id is honoured, anything else is replaced by a minted one', async t => {
  const given = `chat-${crypto.randomUUID()}`;
  const chatId = newChatId('run-id');
  const frames = captureFrames(t, chatId);
  const { service, runLog } = makeService([textTurn('ok')]);

  const summary = await runTurn(service, { chatId, prep: makePrep(), runId: given });
  assert.equal(summary.runId, given);
  assertWellFormed(frames, { runId: given });
  assert.equal(runLog.startRun.calls[0][0].runId, given);

  const chatId2 = newChatId('run-id-bogus');
  const frames2 = captureFrames(t, chatId2);
  const { service: service2 } = makeService([textTurn('ok')]);
  const minted = await runTurn(service2, { chatId: chatId2, prep: makePrep(), runId: 'not a run' });
  assert.match(minted.runId, RUN_ID_RE);
  assert.notEqual(minted.runId, 'not a run');
  assertWellFormed(frames2, { runId: minted.runId });
});

// ── 2. skill activation ─────────────────────────────────────────────────────

test('activatedSkill: tool/progress{skill.activation} is the first frame after run/started; description defaults to ""', async t => {
  const chatId = newChatId('skill');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([textTurn('done')]);

  const summary = await runTurn(service, {
    chatId,
    prep: makePrep(),
    activatedSkill: { skillName: 'summarize', description: 'Summarize the thread' }
  });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [
    RUN_STARTED,
    TOOL_PROGRESS,
    STEP_DELTA,
    STEP_COMPLETED,
    RUN_ENDED
  ]);
  assert.deepEqual(frames[1].data, {
    phase: 'skill.activation',
    message: 'summarize',
    data: { skillName: 'summarize', description: 'Summarize the thread' }
  });

  const chatId2 = newChatId('skill-nodesc');
  const frames2 = captureFrames(t, chatId2);
  const { service: service2 } = makeService([textTurn('done')]);
  await runTurn(service2, {
    chatId: chatId2,
    prep: makePrep(),
    activatedSkill: { skillName: 'translate' }
  });
  assert.deepEqual(frames2[1].data, {
    phase: 'skill.activation',
    message: 'translate',
    data: { skillName: 'translate', description: '' }
  });

  const chatId3 = newChatId('skill-empty');
  const frames3 = captureFrames(t, chatId3);
  const { service: service3 } = makeService([textTurn('done')]);
  await runTurn(service3, { chatId: chatId3, prep: makePrep(), activatedSkill: { skillName: '' } });
  assert.equal(has(frames3, TOOL_PROGRESS), false, 'an empty skill name activates nothing');
});

// ── 3. prompt-implied knowledge sources (upload / email context) ────────────

async function sourcesEmittedFor(t, label, llmMessages) {
  const chatId = newChatId(label);
  const frames = captureFrames(t, chatId);
  const { service } = makeService([textTurn('Here is your answer.')]);
  const summary = await runTurn(service, { chatId, prep: makePrep({ llmMessages }) });
  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(
    types(frames),
    [RUN_STARTED, STEP_DELTA, STEP_COMPLETED, RUN_ENDED],
    `no extra badge frame for ${label}: sources ride on run/ended`
  );
  return {
    completed: frame(frames, STEP_COMPLETED).data,
    ended: frame(frames, RUN_ENDED).data,
    summary
  };
}

test('no tools: a message carrying fileData/imageData ends with run/ended.knowledgeSources ["file"]', async t => {
  const single = await sourcesEmittedFor(t, 'file', [
    {
      role: 'user',
      content: '[File: report.txt (TXT)]\n\nnumbers...\n\nSummarize',
      fileData: { fileName: 'report.txt', fileType: 'text/plain', content: 'numbers...' }
    }
  ]);
  assert.deepEqual(single.ended.knowledgeSources, ['file']);
  assert.deepEqual(single.completed.sources, ['file'], 'the step frame carries the same sources');
  assert.deepEqual(single.summary.knowledgeSources, ['file']);

  const image = await sourcesEmittedFor(t, 'image', [
    {
      role: 'user',
      content: 'Describe this',
      imageData: { base64: 'AAAA', fileType: 'image/png', type: 'image' }
    }
  ]);
  assert.deepEqual(image.ended.knowledgeSources, ['file']);

  const many = await sourcesEmittedFor(t, 'files', [
    {
      role: 'user',
      content: 'Compare these',
      fileData: [
        { fileName: 'a.txt', fileType: 'text/plain', content: 'aaa' },
        { fileName: 'b.txt', fileType: 'text/plain', content: 'bbb' }
      ]
    }
  ]);
  assert.deepEqual(many.ended.knowledgeSources, ['file']);
});

test('no tools: the Office email marker yields knowledgeSources ["email"]; email + upload yields both', async t => {
  const email = await sourcesEmittedFor(t, 'email', [
    { role: 'user', content: '--- Current email ---\nFrom: a@b.c\n\nSummarize this email' }
  ]);
  assert.deepEqual(email.ended.knowledgeSources, ['email']);

  const both = await sourcesEmittedFor(t, 'email-file', [
    {
      role: 'user',
      content: '--- Current email ---\nFrom: a@b.c\n\nCheck the attachment',
      fileData: { fileName: 'deck.pdf', fileType: 'application/pdf', content: 'slides' }
    }
  ]);
  assert.deepEqual([...both.ended.knowledgeSources].sort(), ['email', 'file']);
  assert.deepEqual([...both.completed.sources].sort(), ['email', 'file']);
  assert.deepEqual([...both.summary.knowledgeSources].sort(), ['email', 'file']);
});

// ── 4. tool round ───────────────────────────────────────────────────────────

test('tools path: step/completed{tool_calls} → tool/started → tool/completed → step/delta → step/completed → run/ended{websearch}; runTool gets the chat context; telemetry per model call', async t => {
  const chatId = newChatId('tools');
  const frames = captureFrames(t, chatId);
  const { service, requests, runTool, logInteraction, telemetry, runLog } = makeService(
    [toolTurn([{ name: 'webSearch', args: { query: 'berlin' } }]), textTurn('Sunny.')],
    { runTool: async () => ({ results: ['sunny'] }) }
  );
  const prep = makePrep({ tools: [webSearchTool] });

  const summary = await runTurn(service, { chatId, prep });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [
    RUN_STARTED,
    STEP_COMPLETED,
    TOOL_STARTED,
    TOOL_COMPLETED,
    STEP_DELTA,
    STEP_COMPLETED,
    RUN_ENDED
  ]);

  const [round1, round2] = framesOf(frames, STEP_COMPLETED).map(f => f.data);
  assert.equal(round1.step, 1);
  assert.equal(round1.content, '');
  assert.equal(round1.finishReason, 'tool_calls');
  assert.deepEqual(round1.sources, []);
  assert.equal(round1.toolCalls.length, 1);
  assert.equal(round1.toolCalls[0].id, 'call_1');
  assert.equal(round1.toolCalls[0].index, 0);
  assert.equal(round1.toolCalls[0].type, 'function');
  assert.equal(round1.toolCalls[0].name, 'webSearch');
  assert.deepEqual(JSON.parse(round1.toolCalls[0].arguments), { query: 'berlin' });

  const started = frame(frames, TOOL_STARTED).data;
  assert.deepEqual(started, {
    step: 1,
    callId: 'call_1',
    toolId: 'webSearch',
    name: 'webSearch',
    args: { query: 'berlin' },
    execution: 'server'
  });

  const done = frame(frames, TOOL_COMPLETED).data;
  assert.equal(done.step, 1);
  assert.equal(done.callId, 'call_1');
  assert.equal(done.toolId, 'webSearch');
  assert.equal(done.name, 'webSearch');
  assert.deepEqual(done.resultPreview, { results: ['sunny'] });
  assert.equal(done.error, undefined);
  assert.ok(Number.isInteger(done.durationMs) && done.durationMs >= 0);
  // knowledgeSourceSeam runs before chatToolSeam, so the per-tool hint is on the frame.
  assert.equal(done.knowledgeSource, 'websearch');

  assert.equal(round2.step, 2);
  assert.equal(round2.content, 'Sunny.');
  assert.equal(round2.finishReason, 'stop');
  assert.deepEqual(round2.sources, ['websearch']);
  assert.deepEqual(frame(frames, STEP_DELTA).data, { step: 2, kind: 'text', content: 'Sunny.' });

  const ended = frame(frames, RUN_ENDED).data;
  assert.equal(ended.status, 'completed');
  assert.equal(ended.finishReason, 'stop');
  assert.deepEqual(ended.knowledgeSources, ['websearch']);

  assert.equal(runTool.calls.length, 1);
  assert.equal(runTool.calls[0][0], 'webSearch');
  assert.deepEqual(runTool.calls[0][1], {
    language: 'en',
    query: 'berlin',
    chatId,
    user: USER,
    appConfig: prep.app
  });

  assert.equal(requests.length, 2, 'one model call per round');
  const followUp = requests[1].request.body.messages;
  assert.equal(followUp.at(-2).role, 'assistant');
  assert.equal(followUp.at(-2).tool_calls[0].function.name, 'webSearch');
  assert.equal(followUp.at(-1).role, 'tool');
  assert.deepEqual(JSON.parse(followUp.at(-1).content), { results: ['sunny'] });

  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'Sunny.');
  assert.deepEqual(summary.knowledgeSources, ['websearch']);
  assertLedger(runLog, summary);

  assert.deepEqual(logTypes(logInteraction), ['tool_usage', 'chat_response']);
  assert.equal(logInteraction.calls[0][1].toolId, 'webSearch');
  assert.deepEqual(logInteraction.calls[0][1].toolOutput, { results: ['sunny'] });

  assert.equal(telemetry.recordChatCallStart.calls.length, 2);
  assert.deepEqual(endOutcomes(telemetry), ['completed', 'completed']);
});

// ── 5. tool failure ─────────────────────────────────────────────────────────

test('tool throws: tool/completed carries the error envelope, the model gets it back, tool_error is logged, the turn still completes', async t => {
  const chatId = newChatId('tool-error');
  const frames = captureFrames(t, chatId);
  const { service, requests, logInteraction } = makeService(
    [toolTurn([{ name: 'webSearch', args: { query: 'x' } }]), textTurn('recovered')],
    {
      runTool: async () => {
        throw Object.assign(new Error('provider down'), { code: 'UPSTREAM_DOWN' });
      }
    }
  );

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [webSearchTool] }) });

  assertWellFormed(frames, { runId: summary.runId });
  const done = frame(frames, TOOL_COMPLETED).data;
  assert.equal(done.toolId, 'webSearch');
  assert.equal(done.callId, 'call_1');
  assert.deepEqual(done.error, {
    code: 'UPSTREAM_DOWN',
    message: 'Tool execution failed: provider down'
  });
  assert.deepEqual(done.resultPreview, {
    error: true,
    message: 'Tool execution failed: provider down'
  });
  assert.equal(has(frames, STREAM_ERROR), false, 'a failed tool is not a stream error');

  const toolMsg = requests[1].request.body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.error, true);
  assert.equal(payload.toolId, 'webSearch');
  assert.equal(payload.code, 'UPSTREAM_DOWN');
  assert.equal(payload.message, 'Tool execution failed: provider down');
  assert.equal(typeof payload.details, 'string');

  assert.deepEqual(logTypes(logInteraction), ['tool_error', 'chat_response']);
  assert.equal(logInteraction.calls[0][1].toolId, 'webSearch');
  assert.equal(logInteraction.calls[0][1].error.code, 'UPSTREAM_DOWN');

  assert.equal(frames.at(-1).type, RUN_ENDED);
  assert.equal(frames.at(-1).data.status, 'completed');
  assert.equal(frames.at(-1).data.finishReason, 'stop');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'recovered');
});

// ── 6. clarification (ask_user) ─────────────────────────────────────────────

const askArgs = {
  question: 'Which year?',
  input_type: 'select',
  options: [{ label: '2024' }, { label: '2025' }]
};

test('clarification: ask_user raises interaction/raised, closes the tool, pauses the run (no run/ended) after exactly one model call', async t => {
  const chatId = newChatId('clarify');
  const frames = captureFrames(t, chatId);
  const { service, requests, runTool, logInteraction, telemetry, runLog } = makeService([
    toolTurn([{ name: 'ask_user', args: askArgs }]),
    textTurn('never')
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [
    RUN_STARTED,
    STEP_COMPLETED,
    TOOL_STARTED,
    INTERACTION_RAISED,
    TOOL_COMPLETED,
    RUN_PAUSED
  ]);
  assert.equal(has(frames, RUN_ENDED), false, 'a paused turn has no terminal frame yet');

  const started = frame(frames, TOOL_STARTED).data;
  assert.equal(started.toolId, 'ask_user');
  assert.equal(started.callId, 'call_1');
  assert.equal(started.execution, 'clarification');
  assert.deepEqual(started.args, askArgs);

  const { interaction } = frame(frames, INTERACTION_RAISED).data;
  assert.ok(interaction.id.startsWith(`clarify-${chatId}-1-`));
  assert.equal(interaction.runId, summary.runId);
  assert.equal(interaction.step, 1);
  assert.equal(interaction.kind, 'question');
  assert.equal(interaction.origin, 'tool');
  assert.equal(interaction.status, 'pending');
  assert.equal(interaction.ordinal, 1);
  assert.equal(interaction.prompt.message, 'Which year?');
  assert.equal(interaction.prompt.inputType, 'single_select', 'input_type select → single_select');
  assert.deepEqual(interaction.prompt.options, [
    { value: '2024', label: '2024' },
    { value: '2025', label: '2025' }
  ]);
  assert.equal(interaction.prompt.allowSkip, false);
  assert.equal(interaction.prompt.allowOther, false);
  assert.deepEqual(interaction.source, {
    toolCallId: 'call_1',
    toolId: 'ask_user',
    chatId,
    appId: 'app1'
  });
  assert.equal(interaction.maxClarifications, undefined, 'UI-only cap is not on the wire');

  const done = frame(frames, TOOL_COMPLETED).data;
  assert.equal(done.callId, 'call_1');
  assert.deepEqual(done.resultPreview, { clarificationRequested: true, clarificationNumber: 1 });
  assert.equal(done.error, undefined);

  assert.deepEqual(frame(frames, RUN_PAUSED).data, {
    reason: 'interaction',
    interactionId: interaction.id
  });

  assert.equal(requests.length, 1, 'the model is not called again while waiting for the user');
  assert.equal(runTool.calls.length, 0, 'ask_user never executes as a tool');
  assert.equal(summary.status, 'paused');
  assert.equal(summary.finishReason, 'clarification');
  assert.equal(summary.pendingInteraction.id, interaction.id);
  assert.equal(summary.pendingInteraction.prompt.message, 'Which year?');
  assert.equal(summary.pendingInteraction.maxClarifications, 10, 'cap stays on the summary');
  const toolMsg = summary.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(JSON.parse(toolMsg.content).status, 'awaiting_user_response');

  assertLedger(runLog, summary, { status: 'paused', finishReason: 'clarification' });
  assert.equal(service.getClarificationCount(chatId), 1);
  assert.deepEqual(logTypes(logInteraction), ['clarification_request']);
  assert.equal(logInteraction.calls[0][1].clarificationNumber, 1);
  assert.equal(logInteraction.calls[0][1].maxClarifications, 10);
  assert.deepEqual(endOutcomes(telemetry), ['completed']);
});

test('clarification that cannot be persisted: the model gets a tool error, the run never pauses on a draft nobody could answer', async t => {
  const chatId = newChatId('clarify-fail');
  const frames = captureFrames(t, chatId);
  const interactionService = {
    async raise() {
      throw new Error('store unavailable');
    }
  };
  const { service, requests } = makeService(
    [toolTurn([{ name: 'ask_user', args: askArgs }]), textTurn('Proceeding without the answer.')],
    { interactionService }
  );

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assert.equal(has(frames, INTERACTION_RAISED), false, 'no interaction frame for a draft');
  assert.equal(has(frames, RUN_PAUSED), false, 'the run is not paused');
  assert.equal(requests.length, 2, 'the model is told and continues');
  const toolResult = requests[1].request.body.messages.find(m => m.role === 'tool');
  assert.match(toolResult.content, /Clarification could not be raised: store unavailable/);
  assert.equal(summary.status, 'completed');
  assert.equal(frame(frames, RUN_ENDED).data.status, 'completed');
});

test('clarification cap: the 11th ask_user on a chat is refused with CLARIFICATION_LIMIT_REACHED and the model continues', async t => {
  const chatId = newChatId('clarify-cap');
  const frames = captureFrames(t, chatId);
  const { service, requests, logInteraction } = makeService([
    toolTurn([{ name: 'ask_user', args: askArgs }]),
    textTurn('proceeding with 2025')
  ]);
  for (let i = 0; i < 10; i++) service.incrementClarificationCount(chatId);

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assertWellFormed(frames, { runId: summary.runId });
  assert.equal(has(frames, INTERACTION_RAISED), false);
  assert.equal(has(frames, RUN_PAUSED), false);
  const done = frame(frames, TOOL_COMPLETED).data;
  assert.equal(done.error.code, 'CLARIFICATION_LIMIT_REACHED');
  assert.equal(done.resultPreview.error, true);
  assert.equal(done.resultPreview.code, 'CLARIFICATION_LIMIT_REACHED');
  assert.match(done.resultPreview.message, /Maximum clarification limit \(10\) reached/);

  assert.equal(requests.length, 2);
  const toolMsg = requests[1].request.body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.error, true);
  assert.equal(payload.code, 'CLARIFICATION_LIMIT_REACHED');
  assert.match(payload.message, /Maximum clarification limit \(10\) reached/);

  assert.equal(frames.at(-1).type, RUN_ENDED);
  assert.equal(frames.at(-1).data.finishReason, 'stop');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'proceeding with 2025');
  assert.equal(service.getClarificationCount(chatId), 10, 'a refused question is not counted');
  assert.deepEqual(logTypes(logInteraction), ['tool_usage', 'chat_response']);
  assert.equal(logInteraction.calls[0][1].rateLimited, true);
});

test('clarification counter is bounded: evicts the oldest chatId at 5000 entries, re-increments never evict', () => {
  const service = new ChatService({ agentLoop: {}, logInteraction: async () => {} });
  const MAX = 5000;
  for (let i = 0; i < MAX; i++) service.incrementClarificationCount(`chat-${i}`);
  assert.equal(service.clarificationCounts.size, MAX);
  assert.equal(service.getClarificationCount('chat-0'), 1);

  service.incrementClarificationCount('chat-overflow');
  assert.equal(service.clarificationCounts.size, MAX);
  assert.equal(service.getClarificationCount('chat-0'), 0, 'oldest evicted');
  assert.equal(service.getClarificationCount('chat-overflow'), 1);

  service.incrementClarificationCount('chat-1');
  assert.equal(service.clarificationCounts.size, MAX, 'existing key: no eviction');
  assert.equal(service.getClarificationCount('chat-1'), 2);
  assert.equal(service.getClarificationCount('unknown'), 0);
});

test('clarification with invalid params (no question) → INVALID_CLARIFICATION_PARAMS, not counted', async t => {
  const chatId = newChatId('clarify-invalid');
  const frames = captureFrames(t, chatId);
  const { service, requests } = makeService([
    toolTurn([{ name: 'ask_user', args: { input_type: 'text' } }]),
    textTurn('ok')
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assertWellFormed(frames, { runId: summary.runId });
  assert.equal(has(frames, INTERACTION_RAISED), false);
  const done = frame(frames, TOOL_COMPLETED).data;
  assert.equal(done.error.code, 'INVALID_CLARIFICATION_PARAMS');
  assert.equal(done.resultPreview.code, 'INVALID_CLARIFICATION_PARAMS');
  assert.match(done.resultPreview.message, /Question is required/);
  const payload = JSON.parse(requests[1].request.body.messages.at(-1).content);
  assert.equal(payload.code, 'INVALID_CLARIFICATION_PARAMS');
  assert.match(payload.message, /Question is required/);
  assert.equal(service.getClarificationCount(chatId), 0);
  assert.equal(summary.finishReason, 'stop');
  assert.equal(summary.content, 'ok');
});

test('non-streaming turn: ask_user is refused with NO_USER_AVAILABLE, the answer comes back in the summary, no frame is emitted at all', async t => {
  const chatId = newChatId('headless');
  const frames = captureFrames(t, chatId);
  const { service, requests, logInteraction, telemetry, runLog } = makeService([
    toolTurn([{ name: 'ask_user', args: askArgs }]),
    textTurn('Assumed 2025.')
  ]);

  const summary = await runTurn(service, {
    chatId,
    streaming: false,
    prep: makePrep({ tools: [askUserTool] })
  });

  assert.equal(requests.length, 2);
  const payload = JSON.parse(requests[1].request.body.messages.at(-1).content);
  assert.equal(payload.error, true);
  assert.equal(payload.code, 'NO_USER_AVAILABLE');
  assert.equal(service.getClarificationCount(chatId), 0);

  assert.match(summary.runId, RUN_ID_RE, 'headless turns are still runs');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.finishReason, 'stop');
  assert.equal(summary.content, 'Assumed 2025.');
  assert.equal(summary.pendingInteraction, undefined);

  // Headless: nothing goes to the stream — not the run frames, not the tool
  // frames the seams would otherwise project.
  assert.deepEqual(frames, [], 'no frames for a non-streaming turn');

  assert.equal(activeRequests.has(chatId), false, 'headless turns are not tracked as in-flight');
  assertLedger(runLog, summary);
  assert.deepEqual(logTypes(logInteraction), ['chat_response']);
  assert.equal(logInteraction.calls[0][1].streaming, false);
  assert.deepEqual(endOutcomes(telemetry), ['completed', 'completed']);
  assert.equal(telemetry.recordChatCallStart.calls[0][0].baseLog.streaming, false);
});

// ── 7. passthrough (workflow) tool ──────────────────────────────────────────

test('passthrough: tool text streams as step/delta, closes with tool/completed{answer} and run/ended{tool_passthrough_complete}; no model follow-up', async t => {
  const chatId = newChatId('passthrough');
  const frames = captureFrames(t, chatId);
  const { service, requests, runTool, logInteraction, telemetry, runLog } = makeService(
    [toolTurn([{ name: 'workflow_x', args: { topic: 'q3' } }]), textTurn('never')],
    {
      runTool: () =>
        (async function* () {
          yield 'Hel';
          yield 'lo';
        })()
    }
  );
  const prep = makePrep({
    tools: [workflowTool],
    userFileData: { fileName: 'brief.pdf', fileType: 'application/pdf', content: 'brief' }
  });

  const summary = await runTurn(service, { chatId, prep });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [
    RUN_STARTED,
    STEP_COMPLETED,
    TOOL_STARTED,
    STEP_DELTA,
    STEP_DELTA,
    TOOL_COMPLETED,
    RUN_ENDED
  ]);

  const started = frame(frames, TOOL_STARTED).data;
  assert.equal(started.toolId, 'workflow_x');
  assert.equal(started.callId, 'call_1');
  assert.equal(started.execution, 'passthrough');
  assert.deepEqual(started.args, { topic: 'q3' });
  assert.deepEqual(
    framesOf(frames, STEP_DELTA).map(f => f.data),
    [
      { step: 1, kind: 'text', content: 'Hel' },
      { step: 1, kind: 'text', content: 'lo' }
    ],
    'tool text is plain step/delta on the tool step'
  );
  const done = frame(frames, TOOL_COMPLETED).data;
  assert.equal(done.toolId, 'workflow_x');
  assert.deepEqual(done.resultPreview, { answer: 'Hello' });
  assert.equal(done.error, undefined);

  const ended = frame(frames, RUN_ENDED).data;
  assert.equal(ended.status, 'completed');
  assert.equal(ended.finishReason, 'tool_passthrough_complete');
  assert.equal(ended.toolName, 'workflow_x');
  assert.deepEqual(ended.knowledgeSources, []);

  assert.equal(requests.length, 1, 'the model gets no follow-up call');
  assert.equal(runTool.calls.length, 1);
  assert.equal(runTool.calls[0][0], 'workflow_x');
  const params = runTool.calls[0][1];
  assert.equal(params.topic, 'q3');
  assert.equal(params.passthrough, true);
  assert.equal(params.chatId, chatId);
  assert.equal(params.user, USER);
  assert.equal(params.appConfig, prep.app);
  assert.equal(params._fileData, prep.userFileData, 'workflow tools receive the upload');

  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'Hello');
  assert.equal(summary.finishReason, 'tool_passthrough_complete');
  assert.equal(summary.toolName, 'workflow_x');
  const last = summary.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, 'Hello');
  assert.equal(last.tool_source, 'workflow_x');
  assertLedger(runLog, summary);

  assert.deepEqual(logTypes(logInteraction), ['tool_usage', 'chat_response']);
  assert.deepEqual(logInteraction.calls[0][1].toolOutput, { answer: 'Hello', streaming: true });
  assert.equal(logInteraction.calls[1][1].source, 'passthrough_tool');
  assert.equal(logInteraction.calls[1][1].toolName, 'workflow_x');
  assert.deepEqual(endOutcomes(telemetry), ['completed']);
});

test('passthrough without an upload: no _fileData is handed to the tool', async t => {
  const chatId = newChatId('passthrough-nofile');
  const frames = captureFrames(t, chatId);
  const { service, runTool } = makeService([toolTurn([{ name: 'workflow_x', args: {} }])], {
    runTool: async () => 'plain answer'
  });

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [workflowTool] }) });

  assertWellFormed(frames, { runId: summary.runId });
  assert.equal(Object.hasOwn(runTool.calls[0][1], '_fileData'), false);
  assert.deepEqual(frame(frames, STEP_DELTA).data, {
    step: 1,
    kind: 'text',
    content: 'plain answer'
  });
  assert.deepEqual(frame(frames, TOOL_COMPLETED).data.resultPreview, { answer: 'plain answer' });
  assert.equal(summary.content, 'plain answer');
  assert.equal(summary.finishReason, 'tool_passthrough_complete');
});

// ── 8. provider failure ─────────────────────────────────────────────────────

test('provider HTTP error: exactly one stream/error then run/ended{error}; chat_error logged; telemetry outcome error', async t => {
  const chatId = newChatId('http-500');
  const frames = captureFrames(t, chatId);
  const { service, requests, logInteraction, telemetry, runLog } = makeService(
    [() => textResponse('boom', { status: 500 })],
    { maxRetries: 0 }
  );

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [RUN_STARTED, STREAM_ERROR, RUN_ENDED]);
  assert.equal(framesOf(frames, STREAM_ERROR).length, 1, 'never two errors for one failure');

  const error = frame(frames, STREAM_ERROR).data;
  assert.equal(error.code, LLM_ERROR_CODES.PROVIDER_ERROR);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.equal(error.retryable, false);
  assert.equal(error.isContextWindowError, false);

  const ended = frame(frames, RUN_ENDED).data;
  assert.equal(ended.status, 'error');
  assert.equal(ended.finishReason, 'error');
  assert.deepEqual(ended.error, { code: LLM_ERROR_CODES.PROVIDER_ERROR, message: error.message });
  assert.equal(ended.knowledgeSources, undefined, 'no badge on a failed turn');
  assert.equal(has(frames, STEP_DELTA), false);

  assert.equal(requests.length, 1, 'a 500 with maxRetries 0 is not retried');
  assert.equal(summary.status, 'error');
  assert.equal(summary.finishReason, 'error');
  assert.equal(summary.error.status, 500);
  assert.equal(summary.errorInfo.code, LLM_ERROR_CODES.PROVIDER_ERROR);
  assertLedger(runLog, summary, { errorCode: LLM_ERROR_CODES.PROVIDER_ERROR });

  assert.deepEqual(logTypes(logInteraction), ['chat_error']);
  const [, logData] = logInteraction.calls[0];
  assert.equal(logData.responseType, 'error');
  assert.equal(logData.error.code, LLM_ERROR_CODES.PROVIDER_ERROR);
  assert.equal(logData.error.isContextWindowError, false);

  assert.equal(telemetry.recordChatCallStart.calls.length, 1);
  assert.deepEqual(endOutcomes(telemetry), ['error']);
  assert.equal(telemetry.recordChatCallEnd.calls[0][0].error, summary.error);
  assert.equal(activeRequests.has(chatId), false);
});

// ── 9. abort ────────────────────────────────────────────────────────────────

test('abort mid-turn (stop button / disconnect): run/ended{aborted, connection_closed}, no stream/error, nothing logged', async t => {
  const chatId = newChatId('abort');
  const frames = captureFrames(t, chatId);
  const { service, requests, logInteraction, telemetry, runLog } = makeService([
    () => {
      // What the stop endpoint / SSE teardown does: abort the chat's in-flight controller.
      activeRequests.get(chatId).abort();
      return sseResponse(textTurn('never delivered'));
    }
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [RUN_STARTED, RUN_ENDED]);
  const ended = frame(frames, RUN_ENDED).data;
  assert.equal(ended.status, 'aborted');
  assert.equal(ended.finishReason, 'connection_closed');
  assert.equal(ended.error, undefined);
  assert.equal(has(frames, STREAM_ERROR), false, 'a cancelled turn is not an error');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].ctx.signal.aborted, 'the loop signal is the tracked controller');

  assert.equal(summary.status, 'aborted');
  assert.equal(summary.finishReason, 'connection_closed');
  assert.equal(summary.content, '');
  assertLedger(runLog, summary, { status: 'aborted', finishReason: 'connection_closed' });
  assert.deepEqual(logTypes(logInteraction), []);
  assert.deepEqual(endOutcomes(telemetry), ['aborted']);
  assert.equal(activeRequests.has(chatId), false, 'controller released after the turn');
});

test('a new turn on the same chatId supersedes the previous in-flight controller', async t => {
  const chatId = newChatId('supersede');
  const frames = captureFrames(t, chatId);
  const stale = new AbortController();
  activeRequests.set(chatId, stale);
  const { service } = makeService([textTurn('fresh')]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assertWellFormed(frames, { runId: summary.runId });
  assert.equal(stale.signal.aborted, true, 'previous turn aborted');
  assert.equal(summary.content, 'fresh');
  assert.equal(summary.finishReason, 'stop');
  assert.equal(frame(frames, RUN_ENDED).data.status, 'completed');
  assert.equal(activeRequests.has(chatId), false);
});

// ── 10. degenerate completion ───────────────────────────────────────────────

test('failure finish reason with no output → stream/error{MALFORMED_RESPONSE} + run/ended{error}; with output it is a normal answer', async t => {
  const chatId = newChatId('malformed');
  const frames = captureFrames(t, chatId);
  const { service, logInteraction, telemetry, runLog } = makeService([
    textTurn('', { finishReason: 'MALFORMED_FUNCTION_CALL' })
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assertWellFormed(frames, { runId: summary.runId });
  assert.deepEqual(types(frames), [RUN_STARTED, STEP_COMPLETED, STREAM_ERROR, RUN_ENDED]);
  assert.equal(frame(frames, STEP_COMPLETED).data.finishReason, 'MALFORMED_FUNCTION_CALL');
  assert.equal(frame(frames, STEP_COMPLETED).data.content, '');
  const error = frame(frames, STREAM_ERROR).data;
  assert.equal(error.code, 'MALFORMED_RESPONSE');
  assert.equal(error.message, 'The model returned a malformed response. Please try again.');
  assert.deepEqual(error.details, { finishReason: 'MALFORMED_FUNCTION_CALL' });
  assert.equal(error.retryable, true, 'the user may simply try again');
  const ended = frame(frames, RUN_ENDED).data;
  assert.equal(ended.status, 'error');
  assert.equal(ended.finishReason, 'error');
  assert.deepEqual(ended.error, { code: 'MALFORMED_RESPONSE', message: error.message });

  assert.equal(summary.status, 'error');
  assert.equal(summary.finishReason, 'error');
  assert.deepEqual(summary.errorInfo, {
    message: 'The model returned a malformed response. Please try again.',
    code: 'MALFORMED_RESPONSE'
  });
  assertLedger(runLog, summary, { errorCode: 'MALFORMED_RESPONSE' });
  assert.deepEqual(logTypes(logInteraction), ['chat_error']);
  assert.equal(logInteraction.calls[0][1].error.code, 'MALFORMED_RESPONSE');
  assert.deepEqual(logInteraction.calls[0][1].error.details, {
    finishReason: 'MALFORMED_FUNCTION_CALL'
  });
  assert.deepEqual(endOutcomes(telemetry), ['completed'], 'the model call itself completed');

  // The localized message wins when the caller can translate it.
  const chatId2 = newChatId('malformed-i18n');
  const frames2 = captureFrames(t, chatId2);
  const { service: service2 } = makeService([
    textTurn('', { finishReason: 'MALFORMED_FUNCTION_CALL' })
  ]);
  await runTurn(service2, {
    chatId: chatId2,
    prep: makePrep(),
    getLocalizedError: async key => (key === 'malformedModelResponse' ? 'Kaputt.' : null)
  });
  assert.equal(frame(frames2, STREAM_ERROR).data.message, 'Kaputt.');
  assert.equal(frame(frames2, RUN_ENDED).data.error.message, 'Kaputt.');

  // Same finish reason but the model did produce text → not an error.
  const chatId3 = newChatId('malformed-with-output');
  const frames3 = captureFrames(t, chatId3);
  const { service: service3 } = makeService([
    textTurn('Partial answer', { finishReason: 'MALFORMED_FUNCTION_CALL' })
  ]);
  const ok = await runTurn(service3, { chatId: chatId3, prep: makePrep() });
  assertWellFormed(frames3, { runId: ok.runId });
  assert.deepEqual(types(frames3), [RUN_STARTED, STEP_DELTA, STEP_COMPLETED, RUN_ENDED]);
  assert.equal(frame(frames3, RUN_ENDED).data.status, 'completed');
  assert.equal(frame(frames3, RUN_ENDED).data.finishReason, 'MALFORMED_FUNCTION_CALL');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.content, 'Partial answer');
});

// ── 11. markInteractiveTools ────────────────────────────────────────────────

test('markInteractiveTools flags ask_user and requiresUserInput tools, leaves the rest untouched', () => {
  const plain = { id: 'webSearch', parameters: {} };
  const already = { id: 'ask_user', interactive: true };
  const flagged = { id: 'custom_prompt', requiresUserInput: true };
  const out = markInteractiveTools([askUserTool, plain, already, flagged, null]);

  assert.equal(out.length, 5);
  assert.equal(out[0].interactive, true);
  assert.notEqual(out[0], askUserTool, 'flagged tools are copies');
  assert.equal(askUserTool.interactive, undefined, 'input not mutated');
  assert.equal(out[1], plain, 'non-interactive tools keep their identity');
  assert.equal(out[2], already, 'already interactive tools are returned as-is');
  assert.equal(out[3].interactive, true);
  assert.equal(out[3].requiresUserInput, true);
  assert.equal(out[4], null);

  assert.deepEqual(markInteractiveTools(undefined), []);
  assert.deepEqual(markInteractiveTools('nope'), []);
  assert.equal(
    markInteractiveTools([{ id: 'x', requiresUserInput: false }])[0].interactive,
    undefined
  );
});

// ── 12. image lift ──────────────────────────────────────────────────────────

test('image lift: a tool result carrying imageData reaches the model as "Retrieved image: <name>"; the client sees the raw result', async t => {
  const chatId = newChatId('image-lift');
  const frames = captureFrames(t, chatId);
  const imageResult = {
    imageData: { type: 'image', base64: 'AAAA', format: 'image/png', filename: 'a.png' }
  };
  const { service, requests } = makeService(
    [
      toolTurn([{ name: 'webContentExtractor', args: { url: 'https://x/a.png' } }]),
      textTurn('A cat.')
    ],
    { runTool: async () => imageResult }
  );

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [fetchTool] }) });

  assertWellFormed(frames, { runId: summary.runId });
  const toolMsg = requests[1].request.body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.content, 'Retrieved image: a.png');
  assert.deepEqual(toolMsg.imageData, {
    type: 'image',
    format: 'image/png',
    base64: 'AAAA',
    filename: 'a.png'
  });
  const done = frame(frames, TOOL_COMPLETED).data;
  assert.deepEqual(done.resultPreview, imageResult, 'the client sees the raw tool result');
  assert.equal(done.knowledgeSource, undefined, 'a fetch tool is not a knowledge source');
  assert.deepEqual(frame(frames, RUN_ENDED).data.knowledgeSources, []);
  assert.equal(summary.content, 'A cat.');
  assert.deepEqual(summary.knowledgeSources, []);
});

// ── 13. answer-source bookkeeping (resolveAnswerSources / getKnowledgeSources) ──

test('resolveAnswerSources merges loop and prompt sources, clears them and emits no frame of its own', t => {
  const chatId = newChatId('resolve');
  const frames = captureFrames(t, chatId);
  const service = new ChatService({ agentLoop: {}, logInteraction: async () => {} });
  PromptService.trackPromptSources(chatId);
  t.after(() => PromptService.resetPromptSources(chatId));

  assert.deepEqual(service.getKnowledgeSources(chatId, ['file', 'sources']).sort(), [
    'file',
    'sources'
  ]);

  const resolved = service.resolveAnswerSources(chatId, ['file', 'grounding']);
  assert.deepEqual([...resolved].sort(), ['file', 'grounding', 'sources']);
  assert.deepEqual(service.getKnowledgeSources(chatId), [], 'prompt sources cleared');
  assert.deepEqual(PromptService.getPromptSources(chatId), []);

  assert.deepEqual(service.resolveAnswerSources(chatId), [], 'idempotent: nothing stale');
  assert.deepEqual(frames, [], 'pure bookkeeping — the badge rides on run/ended');
});

test('resolveAnswerSources returns nothing without sources and keeps conversations isolated', t => {
  const chatA = newChatId('iso-a');
  const chatB = newChatId('iso-b');
  const framesA = captureFrames(t, chatA);
  const framesB = captureFrames(t, chatB);
  const service = new ChatService({ agentLoop: {}, logInteraction: async () => {} });
  PromptService.trackPromptSources(chatA);
  t.after(() => PromptService.resetPromptSources(chatA));

  assert.deepEqual(service.getKnowledgeSources(chatB), []);
  assert.deepEqual(service.resolveAnswerSources(chatB, []), []);
  assert.deepEqual(service.resolveAnswerSources(chatA), ['sources']);
  assert.deepEqual(PromptService.getPromptSources(chatA), []);
  assert.deepEqual(framesA, []);
  assert.deepEqual(framesB, []);
});

test('prompt sources tracked before a turn end up in run/ended.knowledgeSources and never leak into the next turn; seq keeps climbing across turns', async t => {
  const chatId = newChatId('prompt-sources');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([textTurn('From the docs.'), textTurn('Plain.')]);
  PromptService.trackPromptSources(chatId);
  t.after(() => PromptService.resetPromptSources(chatId));

  const first = await runTurn(service, { chatId, prep: makePrep() });
  assertWellFormed(frames, { runId: first.runId });
  assert.deepEqual(first.knowledgeSources, ['sources']);
  assert.deepEqual(frame(frames, RUN_ENDED).data.knowledgeSources, ['sources']);
  assert.deepEqual(
    frame(frames, STEP_COMPLETED).data.sources,
    [],
    'prompt sources are chat bookkeeping, not loop sources'
  );
  assert.deepEqual(PromptService.getPromptSources(chatId), [], 'reset after the turn');
  const lastSeq = frames.at(-1).seq;

  frames.length = 0;
  const second = await runTurn(service, { chatId, prep: makePrep() });
  assertWellFormed(frames, { runId: second.runId });
  assert.notEqual(second.runId, first.runId, 'every turn is its own run');
  assert.ok(frames[0].seq > lastSeq, 'seq is per stream, not per run');
  assert.deepEqual(second.knowledgeSources, []);
  assert.deepEqual(
    frame(frames, RUN_ENDED).data.knowledgeSources,
    [],
    'no stale badge on the follow-up turn'
  );
});
