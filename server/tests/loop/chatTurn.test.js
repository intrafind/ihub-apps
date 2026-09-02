/**
 * Chat turn specs — `ChatService.runTurn` on the shared agent loop.
 *
 * Pins the chat SSE dialect (`processing`, `chunk`, `tool.call.*`,
 * `clarification`, `tool-stream-complete`, `answer.source`, `error`, `done`),
 * the interaction log, the per-call usage telemetry, the clarification
 * counter and the answer-source badge for every terminal path of a turn.
 *
 * Driven like agentLoop.test.js: the real `AgentLoop` + `LLMClient` with a
 * scripted OpenAI-wire transport (no network), a `ChatService` whose
 * collaborators (tool runner, interaction logger, telemetry) are spies, and
 * SSE events captured straight off `actionTracker`'s `fire-sse` channel.
 *
 * Ported from: toolExecutor-error-done-events, toolExecutor-clarification-count-cap,
 * toolExecutor-usage-telemetry, tool-executor-knowledge-sources,
 * tool-executor-answer-source-detection, streaming-answer-source-detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ChatService, { markInteractiveTools } from '../../services/chat/ChatService.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { actionTracker } from '../../actionTracker.js';
import { activeRequests } from '../../sse.js';
import PromptService from '../../services/PromptService.js';
import { LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import {
  makeClient,
  sseResponse,
  textResponse,
  openaiText,
  MODELS
} from './helpers/llmFixtures.js';

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

/**
 * A ChatService wired to a scripted loop. Never touches the real toolLoader,
 * usage tracker or interaction log.
 */
function makeService(turns, { runTool, maxRetries = 0 } = {}) {
  const { loop, requests } = makeLoop(turns, { maxRetries });
  const logInteraction = spy(async () => {});
  const telemetry = {
    recordChatCallStart: spy(async () => ({ promptTokens: 0 })),
    recordChatCallEnd: spy(async () => {})
  };
  const runToolSpy = spy(runTool || (async () => ({ ok: true })));
  const service = new ChatService({
    agentLoop: loop,
    logInteraction,
    runTool: runToolSpy,
    telemetry
  });
  return { service, requests, logInteraction, telemetry, runTool: runToolSpy };
}

const USER = { id: 'u1', groups: ['users'] };

function newChatId(label) {
  return `chat-turn-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Capture every `fire-sse` event for one chatId; the listener is removed after the test. */
function captureEvents(t, chatId) {
  const events = [];
  const listener = payload => {
    if (payload?.chatId === chatId) events.push(payload);
  };
  actionTracker.on('fire-sse', listener);
  t.after(() => actionTracker.off('fire-sse', listener));
  return events;
}

const names = events => events.map(e => e.event);
const indexOf = (events, name) => events.findIndex(e => e.event === name);
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

function runTurn(service, { chatId, prep, streaming = true, getLocalizedError }) {
  const buildLogData = (isStreaming, extra = {}) => ({
    ...baseLogFor(chatId, isStreaming),
    ...extra
  });
  return service.runTurn({
    prep,
    chatId,
    streaming,
    buildLogData,
    language: 'en',
    user: USER,
    getLocalizedError: getLocalizedError || (async () => null)
  });
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

test('no tools, streaming: processing → chunks → done{stop}; log + telemetry once each', async t => {
  const chatId = newChatId('plain');
  const events = captureEvents(t, chatId);
  const { service, requests, logInteraction, telemetry } = makeService([
    openaiText(['Hello', ' there'])
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assert.deepEqual(names(events), ['processing', 'chunk', 'chunk', 'done']);
  assert.equal(events[0].message, 'Processing your request...');
  assert.deepEqual(
    events.filter(e => e.event === 'chunk').map(e => e.content),
    ['Hello', ' there']
  );
  assert.equal(events[3].finishReason, 'stop');
  assert.equal(indexOf(events, 'answer.source'), -1, 'no badge without a source');

  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'Hello there');
  assert.equal(summary.finishReason, 'stop');
  assert.deepEqual(summary.knowledgeSources, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.body.tools, undefined, 'no tools offered');

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

// ── 2. prompt-implied knowledge sources (upload / email context) ────────────

async function sourcesEmittedFor(t, label, llmMessages) {
  const chatId = newChatId(label);
  const events = captureEvents(t, chatId);
  const { service } = makeService([textTurn('Here is your answer.')]);
  const summary = await runTurn(service, { chatId, prep: makePrep({ llmMessages }) });
  const badge = indexOf(events, 'answer.source');
  const done = indexOf(events, 'done');
  assert.ok(badge >= 0, `answer.source emitted for ${label}`);
  assert.ok(badge < done, 'badge precedes done so the client attaches it to the message');
  assert.equal(events[badge].type, 'mixed');
  return { badge: events[badge], summary };
}

test('no tools: a message carrying fileData/imageData emits answer.source ["file"] before done', async t => {
  const single = await sourcesEmittedFor(t, 'file', [
    {
      role: 'user',
      content: '[File: report.txt (TXT)]\n\nnumbers...\n\nSummarize',
      fileData: { fileName: 'report.txt', fileType: 'text/plain', content: 'numbers...' }
    }
  ]);
  assert.deepEqual(single.badge.sources, ['file']);
  assert.deepEqual(single.summary.knowledgeSources, ['file']);

  const image = await sourcesEmittedFor(t, 'image', [
    {
      role: 'user',
      content: 'Describe this',
      imageData: { base64: 'AAAA', fileType: 'image/png', type: 'image' }
    }
  ]);
  assert.deepEqual(image.badge.sources, ['file']);

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
  assert.deepEqual(many.badge.sources, ['file']);
});

test('no tools: the Office email marker emits answer.source ["email"]; email + upload emits both', async t => {
  const email = await sourcesEmittedFor(t, 'email', [
    { role: 'user', content: '--- Current email ---\nFrom: a@b.c\n\nSummarize this email' }
  ]);
  assert.deepEqual(email.badge.sources, ['email']);

  const both = await sourcesEmittedFor(t, 'email-file', [
    {
      role: 'user',
      content: '--- Current email ---\nFrom: a@b.c\n\nCheck the attachment',
      fileData: { fileName: 'deck.pdf', fileType: 'application/pdf', content: 'slides' }
    }
  ]);
  assert.deepEqual(both.badge.sources.sort(), ['email', 'file']);
  assert.deepEqual(both.summary.knowledgeSources.sort(), ['email', 'file']);
});

// ── 3. tool round ───────────────────────────────────────────────────────────

test('tools path: tool events, "Using tool(s)" status, websearch badge, done{stop}; runTool gets the chat context; telemetry per model call', async t => {
  const chatId = newChatId('tools');
  const events = captureEvents(t, chatId);
  const { service, requests, runTool, logInteraction, telemetry } = makeService(
    [toolTurn([{ name: 'webSearch', args: { query: 'berlin' } }]), textTurn('Sunny.')],
    { runTool: async () => ({ results: ['sunny'] }) }
  );
  const prep = makePrep({ tools: [webSearchTool] });

  const summary = await runTurn(service, { chatId, prep });

  assert.deepEqual(names(events), [
    'action',
    'tool.call.start',
    'tool.call.end',
    'chunk',
    'answer.source',
    'done'
  ]);
  assert.equal(events[0].action, 'processing');
  assert.equal(events[0].message, 'Using tool(s): webSearch...');
  assert.equal(events[1].toolName, 'webSearch');
  assert.deepEqual(events[1].toolInput, { query: 'berlin' });
  assert.equal(events[2].toolName, 'webSearch');
  assert.deepEqual(events[2].toolOutput, { results: ['sunny'] });
  assert.equal(events[2].error, undefined);
  assert.equal(events[3].content, 'Sunny.');
  assert.deepEqual(events[4].sources, ['websearch']);
  assert.equal(events[4].type, 'mixed');
  assert.equal(events[5].finishReason, 'stop');

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

  assert.deepEqual(logTypes(logInteraction), ['tool_usage', 'chat_response']);
  assert.equal(logInteraction.calls[0][1].toolId, 'webSearch');
  assert.deepEqual(logInteraction.calls[0][1].toolOutput, { results: ['sunny'] });

  assert.equal(telemetry.recordChatCallStart.calls.length, 2);
  assert.deepEqual(endOutcomes(telemetry), ['completed', 'completed']);
});

// ── 4. tool failure ─────────────────────────────────────────────────────────

test('tool throws: tool.call.end carries the error envelope, the model gets it back, tool_error is logged, the turn still completes', async t => {
  const chatId = newChatId('tool-error');
  const events = captureEvents(t, chatId);
  const { service, requests, logInteraction } = makeService(
    [toolTurn([{ name: 'webSearch', args: { query: 'x' } }]), textTurn('recovered')],
    {
      runTool: async () => {
        throw Object.assign(new Error('provider down'), { code: 'UPSTREAM_DOWN' });
      }
    }
  );

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [webSearchTool] }) });

  const end = events.find(e => e.event === 'tool.call.end');
  assert.equal(end.toolName, 'webSearch');
  assert.equal(end.error, true);
  assert.equal(end.errorCode, 'UPSTREAM_DOWN');
  assert.equal(end.errorMessage, 'Tool execution failed: provider down');
  assert.equal(end.toolOutput.error, true);
  assert.equal(end.toolOutput.toolId, 'webSearch');

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

  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).finishReason, 'stop');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.content, 'recovered');
});

// ── 5. clarification (ask_user) ─────────────────────────────────────────────

const askArgs = {
  question: 'Which year?',
  input_type: 'select',
  options: [{ label: '2024' }, { label: '2025' }]
};

test('clarification: ask_user pauses the turn with clarification + done{clarification} after exactly one model call', async t => {
  const chatId = newChatId('clarify');
  const events = captureEvents(t, chatId);
  const { service, requests, runTool, logInteraction, telemetry } = makeService([
    toolTurn([{ name: 'ask_user', args: askArgs }]),
    textTurn('never')
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assert.deepEqual(names(events), [
    'action',
    'tool.call.start',
    'clarification',
    'tool.call.end',
    'done'
  ]);
  assert.equal(events[1].toolName, 'ask_user');
  assert.deepEqual(events[1].toolInput, askArgs);

  const clarification = events[2];
  assert.equal(clarification.question, 'Which year?');
  assert.equal(clarification.inputType, 'single_select');
  assert.deepEqual(clarification.options, [
    { label: '2024', value: '2024' },
    { label: '2025', value: '2025' }
  ]);
  assert.equal(clarification.clarificationNumber, 1);
  assert.equal(clarification.maxClarifications, 10);
  assert.equal(clarification.toolCallId, 'call_1');
  assert.ok(clarification.questionId.startsWith(`clarify-${chatId}-1-`));
  assert.equal(clarification.allowSkip, false);
  assert.equal(clarification.allowOther, false);

  assert.deepEqual(events[3].toolOutput, { clarificationRequested: true, clarificationNumber: 1 });
  assert.equal(events[3].error, undefined);

  assert.equal(events[4].finishReason, 'clarification');
  assert.equal(events[4].clarificationData.toolCallId, 'call_1');
  assert.equal(events[4].clarificationData.question, 'Which year?');
  assert.equal(indexOf(events, 'answer.source'), -1, 'no badge on a paused turn');

  assert.equal(requests.length, 1, 'the model is not called again while waiting for the user');
  assert.equal(runTool.calls.length, 0, 'ask_user never executes as a tool');
  assert.equal(summary.status, 'paused');
  assert.equal(summary.finishReason, 'clarification');
  assert.equal(summary.clarificationData.question, 'Which year?');
  const toolMsg = summary.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(JSON.parse(toolMsg.content).status, 'awaiting_user_response');

  assert.equal(service.getClarificationCount(chatId), 1);
  assert.deepEqual(logTypes(logInteraction), ['clarification_request']);
  assert.equal(logInteraction.calls[0][1].clarificationNumber, 1);
  assert.equal(logInteraction.calls[0][1].maxClarifications, 10);
  assert.deepEqual(endOutcomes(telemetry), ['completed']);
});

test('clarification cap: the 11th ask_user on a chat is refused with CLARIFICATION_LIMIT_REACHED and the model continues', async t => {
  const chatId = newChatId('clarify-cap');
  const events = captureEvents(t, chatId);
  const { service, requests, logInteraction } = makeService([
    toolTurn([{ name: 'ask_user', args: askArgs }]),
    textTurn('proceeding with 2025')
  ]);
  for (let i = 0; i < 10; i++) service.incrementClarificationCount(chatId);

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assert.equal(indexOf(events, 'clarification'), -1);
  const end = events.find(e => e.event === 'tool.call.end');
  assert.equal(end.error, true);
  assert.equal(end.toolOutput.code, 'CLARIFICATION_LIMIT_REACHED');

  assert.equal(requests.length, 2);
  const toolMsg = requests[1].request.body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.error, true);
  assert.equal(payload.code, 'CLARIFICATION_LIMIT_REACHED');
  assert.match(payload.message, /Maximum clarification limit \(10\) reached/);

  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).finishReason, 'stop');
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
  const events = captureEvents(t, chatId);
  const { service, requests } = makeService([
    toolTurn([{ name: 'ask_user', args: { input_type: 'text' } }]),
    textTurn('ok')
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [askUserTool] }) });

  assert.equal(indexOf(events, 'clarification'), -1);
  const end = events.find(e => e.event === 'tool.call.end');
  assert.equal(end.error, true);
  assert.equal(end.toolOutput.code, 'INVALID_CLARIFICATION_PARAMS');
  const payload = JSON.parse(requests[1].request.body.messages.at(-1).content);
  assert.equal(payload.code, 'INVALID_CLARIFICATION_PARAMS');
  assert.match(payload.message, /Question is required/);
  assert.equal(service.getClarificationCount(chatId), 0);
  assert.equal(summary.finishReason, 'stop');
  assert.equal(summary.content, 'ok');
});

test('non-streaming turn: ask_user is refused with NO_USER_AVAILABLE, the answer comes back in the summary, nothing terminal is emitted', async t => {
  const chatId = newChatId('headless');
  const events = captureEvents(t, chatId);
  const { service, requests, logInteraction, telemetry } = makeService([
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

  assert.equal(summary.status, 'completed');
  assert.equal(summary.finishReason, 'stop');
  assert.equal(summary.content, 'Assumed 2025.');
  assert.equal(summary.clarificationData, undefined);

  // Headless: no stream-only events (status line, chunks, badge, terminal events).
  // The tool-call projection itself is not gated on `streaming` — tool.call.*
  // still fire on the chat's channel even though nobody is subscribed to it.
  const streamOnly = ['processing', 'action', 'chunk', 'clarification', 'answer.source', 'done'];
  assert.deepEqual(
    names(events).filter(n => streamOnly.includes(n)),
    [],
    'no stream-only events for a non-streaming turn'
  );
  assert.deepEqual(names(events), ['tool.call.start', 'tool.call.end']);
  assert.equal(events[1].error, true);
  assert.equal(events[1].toolOutput.code, 'NO_USER_AVAILABLE');

  assert.equal(activeRequests.has(chatId), false, 'headless turns are not tracked as in-flight');
  assert.deepEqual(logTypes(logInteraction), ['chat_response']);
  assert.equal(logInteraction.calls[0][1].streaming, false);
  assert.deepEqual(endOutcomes(telemetry), ['completed', 'completed']);
  assert.equal(telemetry.recordChatCallStart.calls[0][0].baseLog.streaming, false);
});

// ── 6. passthrough (workflow) tool ──────────────────────────────────────────

test('passthrough: the tool streams the answer as chunk{source:"tool"}, closes with tool-stream-complete and done{tool_passthrough_complete}; no model follow-up', async t => {
  const chatId = newChatId('passthrough');
  const events = captureEvents(t, chatId);
  const { service, requests, runTool, logInteraction, telemetry } = makeService(
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

  assert.deepEqual(names(events), [
    'action',
    'tool.call.start',
    'chunk',
    'chunk',
    'tool-stream-complete',
    'tool.call.end',
    'done'
  ]);
  assert.equal(events[0].message, 'Using tool(s): workflow_x...');
  assert.equal(events[1].toolName, 'workflow_x');
  assert.deepEqual(events[1].toolInput, { topic: 'q3' });
  assert.deepEqual(
    events
      .filter(e => e.event === 'chunk')
      .map(({ content, source, toolName }) => ({
        content,
        source,
        toolName
      })),
    [
      { content: 'Hel', source: 'tool', toolName: 'workflow_x' },
      { content: 'lo', source: 'tool', toolName: 'workflow_x' }
    ]
  );
  assert.equal(events[4].toolName, 'workflow_x');
  assert.equal(events[4].content, 'Hello');
  assert.deepEqual(events[5].toolOutput, { answer: 'Hello' });
  assert.equal(events[6].finishReason, 'tool_passthrough_complete');
  assert.equal(events[6].toolName, 'workflow_x');
  assert.equal(indexOf(events, 'answer.source'), -1);

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

  assert.deepEqual(logTypes(logInteraction), ['tool_usage', 'chat_response']);
  assert.deepEqual(logInteraction.calls[0][1].toolOutput, { answer: 'Hello', streaming: true });
  assert.equal(logInteraction.calls[1][1].source, 'passthrough_tool');
  assert.equal(logInteraction.calls[1][1].toolName, 'workflow_x');
  assert.deepEqual(endOutcomes(telemetry), ['completed']);
});

test('passthrough without an upload: no _fileData is handed to the tool', async t => {
  const chatId = newChatId('passthrough-nofile');
  captureEvents(t, chatId);
  const { service, runTool } = makeService([toolTurn([{ name: 'workflow_x', args: {} }])], {
    runTool: async () => 'plain answer'
  });

  const summary = await runTurn(service, { chatId, prep: makePrep({ tools: [workflowTool] }) });

  assert.equal(Object.hasOwn(runTool.calls[0][1], '_fileData'), false);
  assert.equal(summary.content, 'plain answer');
  assert.equal(summary.finishReason, 'tool_passthrough_complete');
});

// ── 7. provider failure ─────────────────────────────────────────────────────

test('provider HTTP error: exactly one error event then done{error}; chat_error logged; telemetry outcome error', async t => {
  const chatId = newChatId('http-500');
  const events = captureEvents(t, chatId);
  const { service, requests, logInteraction, telemetry } = makeService(
    [() => textResponse('boom', { status: 500 })],
    { maxRetries: 0 }
  );

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assert.deepEqual(names(events), ['processing', 'error', 'done']);
  assert.equal(
    events.filter(e => e.event === 'error').length,
    1,
    'never two errors for one failure'
  );
  assert.equal(typeof events[1].message, 'string');
  assert.ok(events[1].message.length > 0);
  assert.equal(events[1].code, LLM_ERROR_CODES.PROVIDER_ERROR);
  assert.equal(events[1].isContextWindowError, false);
  assert.equal(events[2].finishReason, 'error');
  assert.equal(indexOf(events, 'answer.source'), -1);
  assert.equal(indexOf(events, 'chunk'), -1);

  assert.equal(requests.length, 1, 'a 500 with maxRetries 0 is not retried');
  assert.equal(summary.status, 'error');
  assert.equal(summary.finishReason, 'error');
  assert.equal(summary.error.status, 500);
  assert.equal(summary.errorInfo.code, LLM_ERROR_CODES.PROVIDER_ERROR);

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

// ── 8. abort ────────────────────────────────────────────────────────────────

test('abort mid-turn (stop button / disconnect): done{connection_closed}, no error event, nothing logged', async t => {
  const chatId = newChatId('abort');
  const events = captureEvents(t, chatId);
  const { service, requests, logInteraction, telemetry } = makeService([
    () => {
      // What the stop endpoint / SSE teardown does: abort the chat's in-flight controller.
      activeRequests.get(chatId).abort();
      return sseResponse(textTurn('never delivered'));
    }
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assert.deepEqual(names(events), ['processing', 'done']);
  assert.equal(events[1].finishReason, 'connection_closed');
  assert.equal(indexOf(events, 'error'), -1, 'a cancelled turn is not an error');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].ctx.signal.aborted, 'the loop signal is the tracked controller');

  assert.equal(summary.status, 'aborted');
  assert.equal(summary.finishReason, 'connection_closed');
  assert.equal(summary.content, '');
  assert.deepEqual(logTypes(logInteraction), []);
  assert.deepEqual(endOutcomes(telemetry), ['aborted']);
  assert.equal(activeRequests.has(chatId), false, 'controller released after the turn');
});

test('a new turn on the same chatId supersedes the previous in-flight controller', async t => {
  const chatId = newChatId('supersede');
  captureEvents(t, chatId);
  const stale = new AbortController();
  activeRequests.set(chatId, stale);
  const { service } = makeService([textTurn('fresh')]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assert.equal(stale.signal.aborted, true, 'previous turn aborted');
  assert.equal(summary.content, 'fresh');
  assert.equal(summary.finishReason, 'stop');
  assert.equal(activeRequests.has(chatId), false);
});

// ── 9. degenerate completion ────────────────────────────────────────────────

test('failure finish reason with no output → error{MALFORMED_RESPONSE} + done{error}; with output it is a normal answer', async t => {
  const chatId = newChatId('malformed');
  const events = captureEvents(t, chatId);
  const { service, logInteraction, telemetry } = makeService([
    textTurn('', { finishReason: 'MALFORMED_FUNCTION_CALL' })
  ]);

  const summary = await runTurn(service, { chatId, prep: makePrep() });

  assert.deepEqual(names(events), ['processing', 'error', 'done']);
  assert.equal(events[1].code, 'MALFORMED_RESPONSE');
  assert.equal(events[1].message, 'The model returned a malformed response. Please try again.');
  assert.equal(events[2].finishReason, 'error');
  assert.equal(summary.status, 'error');
  assert.equal(summary.finishReason, 'error');
  assert.deepEqual(summary.errorInfo, {
    message: 'The model returned a malformed response. Please try again.',
    code: 'MALFORMED_RESPONSE'
  });
  assert.deepEqual(logTypes(logInteraction), ['chat_error']);
  assert.equal(logInteraction.calls[0][1].error.code, 'MALFORMED_RESPONSE');
  assert.deepEqual(logInteraction.calls[0][1].error.details, {
    finishReason: 'MALFORMED_FUNCTION_CALL'
  });
  assert.deepEqual(endOutcomes(telemetry), ['completed'], 'the model call itself completed');

  // The localized message wins when the caller can translate it.
  const chatId2 = newChatId('malformed-i18n');
  const events2 = captureEvents(t, chatId2);
  const { service: service2 } = makeService([
    textTurn('', { finishReason: 'MALFORMED_FUNCTION_CALL' })
  ]);
  await runTurn(service2, {
    chatId: chatId2,
    prep: makePrep(),
    getLocalizedError: async key => (key === 'malformedModelResponse' ? 'Kaputt.' : null)
  });
  assert.equal(events2.find(e => e.event === 'error').message, 'Kaputt.');

  // Same finish reason but the model did produce text → not an error.
  const chatId3 = newChatId('malformed-with-output');
  const events3 = captureEvents(t, chatId3);
  const { service: service3 } = makeService([
    textTurn('Partial answer', { finishReason: 'MALFORMED_FUNCTION_CALL' })
  ]);
  const ok = await runTurn(service3, { chatId: chatId3, prep: makePrep() });
  assert.deepEqual(names(events3), ['processing', 'chunk', 'done']);
  assert.equal(events3[2].finishReason, 'MALFORMED_FUNCTION_CALL');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.content, 'Partial answer');
});

// ── 10. markInteractiveTools ────────────────────────────────────────────────

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

// ── 11. image lift ──────────────────────────────────────────────────────────

test('image lift: a tool result carrying imageData reaches the model as "Retrieved image: <name>"', async t => {
  const chatId = newChatId('image-lift');
  const events = captureEvents(t, chatId);
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

  const toolMsg = requests[1].request.body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.content, 'Retrieved image: a.png');
  assert.deepEqual(toolMsg.imageData, {
    type: 'image',
    format: 'image/png',
    base64: 'AAAA',
    filename: 'a.png'
  });
  const end = events.find(e => e.event === 'tool.call.end');
  assert.deepEqual(end.toolOutput, imageResult, 'the client sees the raw tool result');
  assert.equal(indexOf(events, 'answer.source'), -1, 'a fetch tool is not a knowledge source');
  assert.equal(summary.content, 'A cat.');
  assert.deepEqual(summary.knowledgeSources, []);
});

// ── answer-source bookkeeping (finalizeAnswerSource / getKnowledgeSources) ──

test('finalizeAnswerSource emits one badge merging loop and prompt sources, then clears them', t => {
  const chatId = newChatId('finalize');
  const events = captureEvents(t, chatId);
  const service = new ChatService({ agentLoop: {}, logInteraction: async () => {} });
  PromptService.trackPromptSources(chatId);
  t.after(() => PromptService.resetPromptSources(chatId));

  assert.deepEqual(service.getKnowledgeSources(chatId, ['file', 'sources']).sort(), [
    'file',
    'sources'
  ]);

  service.finalizeAnswerSource(chatId, ['file', 'grounding']);
  assert.deepEqual(names(events), ['answer.source']);
  assert.deepEqual(events[0].sources.sort(), ['file', 'grounding', 'sources']);
  assert.equal(events[0].type, 'mixed');
  assert.deepEqual(service.getKnowledgeSources(chatId), [], 'prompt sources cleared');
  assert.deepEqual(PromptService.getPromptSources(chatId), []);

  service.finalizeAnswerSource(chatId);
  assert.equal(events.length, 1, 'idempotent: no stale re-emit');
});

test('finalizeAnswerSource emits nothing without sources and keeps conversations isolated', t => {
  const chatA = newChatId('iso-a');
  const chatB = newChatId('iso-b');
  const eventsA = captureEvents(t, chatA);
  const eventsB = captureEvents(t, chatB);
  const service = new ChatService({ agentLoop: {}, logInteraction: async () => {} });
  PromptService.trackPromptSources(chatA);
  t.after(() => PromptService.resetPromptSources(chatA));

  assert.deepEqual(service.getKnowledgeSources(chatB), []);
  service.finalizeAnswerSource(chatB, []);
  assert.deepEqual(eventsB, []);

  service.finalizeAnswerSource(chatA);
  assert.deepEqual(
    eventsA.map(e => e.sources),
    [['sources']]
  );
});

test('prompt sources tracked before a turn end up in the badge and never leak into the next turn', async t => {
  const chatId = newChatId('prompt-sources');
  const events = captureEvents(t, chatId);
  const { service } = makeService([textTurn('From the docs.'), textTurn('Plain.')]);
  PromptService.trackPromptSources(chatId);
  t.after(() => PromptService.resetPromptSources(chatId));

  const first = await runTurn(service, { chatId, prep: makePrep() });
  assert.deepEqual(first.knowledgeSources, ['sources']);
  const badge = events.find(e => e.event === 'answer.source');
  assert.deepEqual(badge.sources, ['sources']);
  assert.ok(indexOf(events, 'answer.source') < indexOf(events, 'done'));
  assert.deepEqual(PromptService.getPromptSources(chatId), [], 'reset after the turn');

  events.length = 0;
  const second = await runTurn(service, { chatId, prep: makePrep() });
  assert.deepEqual(second.knowledgeSources, []);
  assert.equal(indexOf(events, 'answer.source'), -1, 'no stale badge on the follow-up turn');
});
