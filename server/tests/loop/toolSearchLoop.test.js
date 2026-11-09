// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool search (#2889) end to end: `ChatService.runTurn` on the real
 * `AgentLoop` with a scripted provider.
 *
 * The model finds a tool that was left out of the request with `search_tools`
 * and runs it with `call_tool`. What must hold:
 *
 * - the provider is sent the loaded tools and the two search tools, never the
 *   tools that were left out;
 * - a `call_tool` call runs the tool it names through the same `runTool` with
 *   the same context, and shows (activity frames, approval card, run log) as
 *   that tool; the transcript the model sees keeps `call_tool`;
 * - the approval gate decides on the real tool, and a paused call continues
 *   as the real tool with the approved arguments;
 * - a name that is not left out, a tool that is loaded, and arguments that do
 *   not fit are refused without running anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ChatService from '../../services/chat/ChatService.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { startTestStorage } from '../helpers/testStorage.js';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import { setEnvelopeDelivery, stampSeq } from '../../services/loop/RunStream.js';
import { routeEnvelope } from '../../sse.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { makeClient, sseResponse, MODELS } from './helpers/llmFixtures.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';
import { createToolSearch, toolSearchToolDefinitions } from '../../services/tools/toolSearch.js';

const { INTERACTION_RAISED, TOOL_STARTED, TOOL_COMPLETED } = SSE_V2_EVENTS;

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

function textTurn(content) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

function toolTurn(name, args, { id = 'call_1' } = {}) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

/** The model runs a left-out tool through `call_tool`: its arguments are JSON text. */
const callTool = (name, args, options) =>
  toolTurn('call_tool', { name, arguments: JSON.stringify(args) }, options);

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

/** An action of an installed integration, as the tool loader builds and stamps it. */
function action(instance, label, name, title, extra = {}) {
  return {
    id: `${instance}__${name}`,
    name: `${label}: ${title}`,
    description: `${title} in ${label}.`,
    parameters: {
      type: 'object',
      properties: { issue: { type: 'string' }, text: { type: 'string' } },
      required: ['issue']
    },
    type: 'integration',
    readOnly: true,
    sideEffect: 'read',
    dataFlow: 'internal',
    _integration: { instanceId: instance, instanceLabel: label, action: name, actionTitle: title },
    ...extra
  };
}

const SEARCH = action('jira', 'Jira', 'search_issues', 'Search issues');
const COMMENT = action('jira', 'Jira', 'add_comment', 'Add comment', {
  readOnly: false,
  sideEffect: 'write',
  dataFlow: 'external',
  approval: 'always',
  approvalSource: 'tool',
  sideEffectSource: 'tool'
});
const LOADED = action('wiki', 'Wiki', 'get_page', 'Get page');

/** What `prepareChatRequest` hands the turn when Jira was left out of the request. */
function prep(overrides = {}) {
  const searchTools = toolSearchToolDefinitions('en');
  const tools = [LOADED, ...searchTools];
  return {
    app: { id: 'app1' },
    model: MODELS.openai,
    llmMessages: [{ role: 'user', content: 'Comment on ACME-12' }],
    tools,
    toolSearch: createToolSearch({ deferred: [SEARCH, COMMENT], tools }),
    maxTokens: 256,
    llmOptions: {},
    ...overrides
  };
}

function makeService(turns, { interactionService, runTool } = {}) {
  const script = [...turns];
  const requests = [];
  const { client } = makeClient({
    maxRetries: 0,
    transport: async request => {
      requests.push(request);
      const next = script.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      return sseResponse(next);
    }
  });
  const runToolSpy = spy(runTool || (async (toolId, params) => ({ ok: true, toolId, params })));
  const service = new ChatService({
    agentLoop: new AgentLoop({ llmClient: client, logger: silentLogger }),
    logInteraction: spy(async () => {}),
    runTool: runToolSpy,
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} },
    runLog: { startRun: async () => ({}), endRun: () => {} },
    ...(interactionService ? { interactionService } : {})
  });
  return { service, requests, runTool: runToolSpy };
}

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

const newChatId = label => `chat-toolsearch-${label}-${crypto.randomUUID().slice(0, 8)}`;

/** The names of the tools of a request to the provider. */
const sentToolNames = request =>
  request.body.tools.map(tool => tool.function?.name ?? tool.id ?? tool.name);

/** The tool message answering `call_1` in a request. */
const toolMessageOf = (request, id = 'call_1') =>
  request.body.messages.find(m => m.role === 'tool' && m.tool_call_id === id);

test('the provider is sent the loaded tools and the two search tools, not the tools left out', async t => {
  const chatId = newChatId('request');
  captureFrames(t, chatId);
  const { service, requests } = makeService([textTurn('Hello.')]);
  await turn(service, { chatId, prepData: prep() });
  assert.deepEqual(sentToolNames(requests[0]), ['wiki__get_page', 'search_tools', 'call_tool']);
  const sent = JSON.stringify(requests[0].body.tools);
  assert.doesNotMatch(sent, /jira__/, 'the left-out tools are not in the request');
});

test('call_tool runs the tool it names, as that tool, with the context of a direct call', async t => {
  const chatId = newChatId('run');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    callTool('jira__search_issues', { issue: 'ACME-12' }),
    textTurn('Found it.')
  ]);
  const summary = await turn(service, { chatId, prepData: prep() });

  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 1);
  const [toolId, params, options] = runTool.calls[0];
  assert.equal(toolId, 'jira__search_issues', 'runTool gets the real tool, never call_tool');
  assert.equal(params.issue, 'ACME-12');
  assert.equal(params.chatId, chatId);
  assert.equal(params.user.id, 'u1');
  assert.deepEqual(params.appConfig, { id: 'app1' });
  assert.ok(options.signal, 'the turn’s abort signal comes along');
  assert.equal(params.name, undefined, 'the wrapper’s own arguments do not leak into the call');
  assert.equal(params.arguments, undefined);

  // The activity list shows the real tool.
  const [started] = ofType(frames, TOOL_STARTED);
  assert.equal(started.data.toolId, 'jira__search_issues');
  assert.equal(started.data.name, 'jira__search_issues');
  assert.equal(started.data.title, 'Search issues');
  assert.equal(started.data.integration, 'Jira');
  assert.deepEqual(started.data.args, { issue: 'ACME-12' });
  const [done] = ofType(frames, TOOL_COMPLETED);
  assert.equal(done.data.toolId, 'jira__search_issues');

  // The model's transcript is what it wrote: a call of call_tool and its result.
  const next = requests[1].body.messages;
  const assistant = next.find(m => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, 'call_tool');
  assert.equal(toolMessageOf(requests[1]).name, 'call_tool');
  assert.equal(JSON.parse(toolMessageOf(requests[1]).content).ok, true);
});

test('search_tools answers from the tools left out and runs nothing', async t => {
  const chatId = newChatId('search');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    toolTurn('search_tools', { query: 'comment' }),
    textTurn('Done.')
  ]);
  await turn(service, { chatId, prepData: prep() });

  assert.equal(runTool.calls.length, 0, 'answered by the loop');
  const answer = toolMessageOf(requests[1]).content;
  assert.match(answer, /jira__add_comment/);
  assert.match(answer, /Parameters \(JSON Schema\)/);
  assert.doesNotMatch(answer, /wiki__get_page/, 'only what was left out');
  const [started] = ofType(frames, TOOL_STARTED);
  assert.equal(started.data.toolId, 'search_tools');
  assert.equal(started.data.activityKind, 'tool', 'not drawn as a web search');
  assert.equal(started.data.activityScope, undefined);
  assert.equal(ofType(frames, TOOL_COMPLETED).length, 1);
});

test('a name that was not left out is refused like an unknown tool, and nothing runs', async t => {
  const chatId = newChatId('unknown');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    callTool('jira__delete_project', { issue: 'x' }),
    textTurn('Sorry.')
  ]);
  await turn(service, { chatId, prepData: prep() });
  assert.equal(runTool.calls.length, 0);
  const result = JSON.parse(toolMessageOf(requests[1]).content);
  assert.equal(result.reason, 'tool_not_registered');
  assert.match(result.message, /Tool 'jira__delete_project' is not registered/);
});

test('a tool the model has loaded is refused: it is called directly', async t => {
  const chatId = newChatId('loaded');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    callTool('wiki__get_page', { issue: 'x' }),
    textTurn('Ok.')
  ]);
  await turn(service, { chatId, prepData: prep() });
  assert.equal(runTool.calls.length, 0);
  const result = JSON.parse(toolMessageOf(requests[1]).content);
  assert.equal(result.error, true);
  assert.match(result.message, /wiki__get_page is loaded: call it directly/);
});

test('a tool left out cannot be called by its own name: it is not in the request', async t => {
  const chatId = newChatId('direct');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    toolTurn('jira__search_issues', { issue: 'ACME-12' }),
    textTurn('Ok.')
  ]);
  await turn(service, { chatId, prepData: prep() });
  assert.equal(runTool.calls.length, 0);
  assert.equal(JSON.parse(toolMessageOf(requests[1]).content).reason, 'tool_not_registered');
});

test('arguments that do not fit the tool are refused with the reason, and the model can correct them', async t => {
  const chatId = newChatId('invalid');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    callTool('jira__search_issues', { text: 'no issue key' }),
    callTool('jira__search_issues', { issue: 'ACME-12' }, { id: 'call_2' }),
    textTurn('Found it.')
  ]);
  await turn(service, { chatId, prepData: prep() });

  const refusal = JSON.parse(toolMessageOf(requests[1]).content);
  assert.equal(refusal.error, true);
  assert.match(refusal.message, /do not match the parameters of jira__search_issues/);
  assert.match(refusal.message, /issue/);
  assert.equal(runTool.calls.length, 1, 'only the corrected call ran');
  assert.equal(runTool.calls[0][1].issue, 'ACME-12');
});

test('a tool the circuit breaker withheld is refused through call_tool too', async t => {
  const chatId = newChatId('breaker');
  captureFrames(t, chatId);
  const failing = async () => ({ error: true, message: 'Backend unavailable' });
  const calls = [1, 2, 3, 4, 5].map(i =>
    callTool('jira__search_issues', { issue: `ACME-${i}` }, { id: `call_${i}` })
  );
  const { service, runTool, requests } = makeService([...calls, textTurn('Giving up.')], {
    runTool: failing
  });
  await turn(service, { chatId, prepData: prep() });
  const answers = requests.slice(1).map((request, i) => toolMessageOf(request, `call_${i + 1}`));
  const withheld = answers.filter(m => /withheld for this run/.test(m.content));
  assert.ok(withheld.length >= 1, 'a repeatedly failing tool is withheld, not retried forever');
  assert.ok(runTool.calls.length < 5);
});

// ── approval ────────────────────────────────────────────────────────────────

async function interactionsFor(t) {
  const storage = await startTestStorage({ prefix: 'tool-search-' });
  const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog });
  t.after(async () => {
    await svc.stop?.();
    await storage.stop();
  });
  return svc;
}

async function chatStore(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-search-chats-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: silentLogger
  });
  t.after(async () => {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return repository;
}

test('the approval gate decides on the real tool: a write left out still asks, and never runs unapproved', async t => {
  const chatId = newChatId('approval');
  const frames = captureFrames(t, chatId);
  const repository = await chatStore(t);
  const interactionService = await interactionsFor(t);
  const { service, runTool } = makeService(
    [callTool('jira__add_comment', { issue: 'ACME-12', text: 'Looks good' })],
    { interactionService }
  );
  const summary = await turn(service, {
    chatId,
    prepData: prep(),
    persistence: { repository, ownerId: 'u1', identityMode: 'default', content: 'Comment' }
  });

  assert.equal(summary.status, 'paused');
  assert.equal(summary.finishReason, 'approval');
  assert.equal(runTool.calls.length, 0, 'nothing ran');
  assert.equal(ofType(frames, TOOL_STARTED).length, 0, 'a gated call never shows as started');

  const [raised] = ofType(frames, INTERACTION_RAISED);
  const { displayData } = raised.data.interaction.prompt;
  assert.equal(displayData.toolId, 'jira__add_comment', 'the card is about the real tool');
  assert.equal(displayData.toolName, 'Add comment');
  assert.equal(displayData.integration.name, 'Jira');
  assert.equal(displayData.sideEffect, 'write');
  assert.deepEqual(displayData.args, { issue: 'ACME-12', text: 'Looks good' });

  // What is stored to continue the turn: the call as the model wrote it, and
  // the tool it was approved as.
  const stored = (await repository.getChat(chatId)).toolApproval.pending;
  assert.equal(stored.call.name, 'call_tool');
  assert.equal(stored.call.toolId, 'jira__add_comment');
  assert.deepEqual(stored.call.args, { issue: 'ACME-12', text: 'Looks good' });
  const placeholder = stored.transcript.find(m => m.role === 'tool');
  assert.equal(placeholder.name, 'call_tool', 'the transcript keeps the name the model called');
});

test('headless: the refusal names the real tool, and the message keeps call_tool', async t => {
  const chatId = newChatId('headless');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    callTool('jira__add_comment', { issue: 'ACME-12' }),
    textTurn('I could not comment.')
  ]);
  await turn(service, { chatId, prepData: prep(), headless: true });
  assert.equal(runTool.calls.length, 0);
  const message = toolMessageOf(requests[1]);
  assert.equal(message.name, 'call_tool');
  const payload = JSON.parse(message.content);
  assert.equal(payload.code, 'APPROVAL_REQUIRED_NO_USER');
  assert.match(payload.message, /"jira__add_comment"/);
});

test('a per-chat grant of the real tool lets the call run without asking', async t => {
  const chatId = newChatId('grant');
  captureFrames(t, chatId);
  const { service, runTool } = makeService([
    callTool('jira__add_comment', { issue: 'ACME-12' }),
    textTurn('Done.')
  ]);
  const summary = await turn(service, {
    chatId,
    prepData: prep(),
    toolApproval: { grants: ['jira__add_comment'] }
  });
  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls[0][0], 'jira__add_comment');
});

test('approve: the server runs the stored call as the real tool, with exactly the approved arguments', async t => {
  const chatId = newChatId('approve');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([textTurn('The comment was added.')]);
  const approvedArgs = { issue: 'ACME-12', text: 'from the card' };
  const summary = await turn(service, {
    chatId,
    prepData: prep({
      llmMessages: [
        { role: 'user', content: 'Comment on ACME-12' },
        { role: 'user', content: 'Approved: jira__add_comment' }
      ]
    }),
    toolApproval: {
      grants: [],
      resume: {
        interactionId: 'approve-1',
        outcome: 'approved',
        call: { id: 'call_1', name: 'call_tool', toolId: 'jira__add_comment' },
        args: approvedArgs,
        // What the model wrote differs: the approved arguments win.
        transcript: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'call_tool',
                  arguments: JSON.stringify({
                    name: 'jira__add_comment',
                    arguments: JSON.stringify({ issue: 'SOMETHING-ELSE' })
                  })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'call_tool',
            content: JSON.stringify({ status: 'awaiting_approval' })
          }
        ]
      }
    }
  });

  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 1, 'run once, by the server');
  const [toolId, params] = runTool.calls[0];
  assert.equal(toolId, 'jira__add_comment');
  assert.equal(params.issue, 'ACME-12');
  assert.equal(params.text, 'from the card');
  assert.equal(requests.length, 1, 'the model was not asked to issue the call again');
  const message = toolMessageOf(requests[0]);
  assert.equal(message.name, 'call_tool');
  assert.doesNotMatch(message.content, /awaiting_approval/, 'the placeholder was replaced');
  const [started] = ofType(frames, TOOL_STARTED);
  assert.equal(started.data.toolId, 'jira__add_comment');
});

test('approve: a tool that is no longer offered is not run', async t => {
  const chatId = newChatId('gone');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([textTurn('Ok.')]);
  const tools = [LOADED, ...toolSearchToolDefinitions('en')];
  await turn(service, {
    chatId,
    prepData: prep({
      toolSearch: createToolSearch({ deferred: [], tools }),
      llmMessages: [{ role: 'user', content: 'Approved' }]
    }),
    toolApproval: {
      resume: {
        interactionId: 'approve-2',
        outcome: 'approved',
        call: { id: 'call_1', name: 'call_tool', toolId: 'jira__add_comment' },
        args: { issue: 'ACME-12' },
        transcript: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'call_tool', arguments: '{}' }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'call_tool',
            content: JSON.stringify({ status: 'awaiting_approval' })
          }
        ]
      }
    }
  });
  assert.equal(runTool.calls.length, 0);
  assert.equal(JSON.parse(toolMessageOf(requests[0]).content).reason, 'tool_not_registered');
});
