// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool search (#2889) end to end: `ChatService.runTurn` on the real
 * `AgentLoop` with a scripted provider.
 *
 * The model finds a tool that was left out of the request with `search_tools`;
 * what it finds joins the request's tools from its next step on, and the model
 * calls it like any other tool. What must hold:
 *
 * - the provider is sent the loaded tools and `search_tools`, never the tools
 *   that were left out, until the model finds them;
 * - a found tool is an ordinary tool call: it runs through the same `runTool`
 *   with the same context and shows (activity frames, approval card, run log)
 *   as itself;
 * - the approval gate decides on a found tool as on any tool, and a paused call
 *   continues as that tool with the approved arguments, though the new request
 *   starts with it left out again;
 * - a tool that was not found cannot be called: it is not in the request.
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
import { createToolSearch, toolSearchToolDefinition } from '../../services/tools/toolSearch.js';

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
  return {
    app: { id: 'app1' },
    model: MODELS.openai,
    llmMessages: [{ role: 'user', content: 'Comment on ACME-12' }],
    tools: [LOADED, toolSearchToolDefinition('en')],
    toolSearch: createToolSearch({ deferred: [SEARCH, COMMENT] }),
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

/** The model's search step, then its next step. */
const search = (query, options) => toolTurn('search_tools', { query }, options);

test('the provider is sent the loaded tools and search_tools, not the tools left out', async t => {
  const chatId = newChatId('request');
  captureFrames(t, chatId);
  const { service, requests } = makeService([textTurn('Hello.')]);
  await turn(service, { chatId, prepData: prep() });
  assert.deepEqual(sentToolNames(requests[0]), ['wiki__get_page', 'search_tools']);
  assert.doesNotMatch(JSON.stringify(requests[0].body.tools), /jira__/);
});

test('search_tools loads what it finds into the very next request, and runs nothing', async t => {
  const chatId = newChatId('load');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([search('comment'), textTurn('Done.')]);
  await turn(service, { chatId, prepData: prep() });

  assert.equal(runTool.calls.length, 0, 'answered by the loop');
  assert.deepEqual(sentToolNames(requests[1]), [
    'wiki__get_page',
    'search_tools',
    'jira__add_comment'
  ]);
  const answer = toolMessageOf(requests[1]).content;
  assert.match(answer, /jira__add_comment/);
  assert.match(answer, /now loaded/);
  assert.doesNotMatch(answer, /jira__search_issues/, 'only what matched');

  const [started] = ofType(frames, TOOL_STARTED);
  assert.equal(started.data.toolId, 'search_tools');
  assert.equal(started.data.activityKind, 'tool', 'not drawn as a web search');
  assert.equal(started.data.activityScope, undefined);
  assert.equal(ofType(frames, TOOL_COMPLETED).length, 1);
});

test('a found tool is called directly, as that tool, with the context of any call', async t => {
  const chatId = newChatId('run');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    search('issues'),
    toolTurn('jira__search_issues', { issue: 'ACME-12' }, { id: 'call_2' }),
    textTurn('Found it.')
  ]);
  const summary = await turn(service, { chatId, prepData: prep() });

  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 1);
  const [toolId, params, options] = runTool.calls[0];
  assert.equal(toolId, 'jira__search_issues');
  assert.equal(params.issue, 'ACME-12');
  assert.equal(params.chatId, chatId);
  assert.equal(params.user.id, 'u1');
  assert.deepEqual(params.appConfig, { id: 'app1' });
  assert.ok(options.signal, 'the turn’s abort signal comes along');

  // The activity list shows the tool the model called.
  const started = ofType(frames, TOOL_STARTED).find(f => f.data.toolId === 'jira__search_issues');
  assert.equal(started.data.name, 'jira__search_issues');
  assert.equal(started.data.title, 'Search issues');
  assert.equal(started.data.integration, 'Jira');
  assert.deepEqual(started.data.args, { issue: 'ACME-12' });

  // Its tool message carries its own name, and the tool stays offered.
  const message = toolMessageOf(requests[2], 'call_2');
  assert.equal(message.name, 'jira__search_issues');
  assert.equal(JSON.parse(message.content).ok, true);
  assert.ok(sentToolNames(requests[2]).includes('jira__search_issues'));
});

test('a tool that was not found cannot be called: it is not in the request', async t => {
  const chatId = newChatId('unfound');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    toolTurn('jira__search_issues', { issue: 'ACME-12' }),
    textTurn('Ok.')
  ]);
  await turn(service, { chatId, prepData: prep() });
  assert.equal(runTool.calls.length, 0);
  const result = JSON.parse(toolMessageOf(requests[1]).content);
  assert.equal(result.reason, 'tool_not_registered');
  assert.match(result.message, /Tool 'jira__search_issues' is not registered/);
});

test('a search that finds nothing loads nothing', async t => {
  const chatId = newChatId('none');
  captureFrames(t, chatId);
  const { service, requests } = makeService([search('zebra'), textTurn('Ok.')]);
  await turn(service, { chatId, prepData: prep() });
  assert.match(toolMessageOf(requests[1]).content, /No tool matches "zebra"/);
  assert.deepEqual(sentToolNames(requests[1]), ['wiki__get_page', 'search_tools']);
});

test('a found tool that keeps failing is withheld like any other tool', async t => {
  const chatId = newChatId('breaker');
  captureFrames(t, chatId);
  const calls = [1, 2, 3].map(i =>
    toolTurn('jira__search_issues', { issue: `ACME-${i}` }, { id: `call_${i + 1}` })
  );
  const { service, runTool, requests } = makeService(
    [search('issues'), ...calls, textTurn('Giving up.')],
    { runTool: async () => ({ error: true, message: 'Backend unavailable' }) }
  );
  await turn(service, { chatId, prepData: prep() });
  assert.equal(runTool.calls.length, 3);
  const last = requests.at(-1);
  assert.ok(!sentToolNames(last).includes('jira__search_issues'), 'withheld after three failures');
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

const COMMENT_ARGS = { issue: 'ACME-12', text: 'Looks good' };

test('a found write still asks first, and never runs unapproved', async t => {
  const chatId = newChatId('approval');
  const frames = captureFrames(t, chatId);
  const repository = await chatStore(t);
  const interactionService = await interactionsFor(t);
  const { service, runTool } = makeService(
    [search('comment'), toolTurn('jira__add_comment', COMMENT_ARGS, { id: 'call_2' })],
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
  assert.ok(
    !ofType(frames, TOOL_STARTED).some(f => f.data.toolId === 'jira__add_comment'),
    'a gated call never shows as started'
  );

  const [raised] = ofType(frames, INTERACTION_RAISED);
  const { displayData } = raised.data.interaction.prompt;
  assert.equal(displayData.toolId, 'jira__add_comment');
  assert.equal(displayData.toolName, 'Add comment');
  assert.equal(displayData.integration.name, 'Jira');
  assert.equal(displayData.sideEffect, 'write');
  assert.deepEqual(displayData.args, COMMENT_ARGS);

  // What is stored to continue the turn is the call as the model wrote it.
  const stored = (await repository.getChat(chatId)).toolApproval.pending;
  assert.equal(stored.call.name, 'jira__add_comment');
  assert.equal(stored.call.toolId, 'jira__add_comment');
  assert.deepEqual(stored.call.args, COMMENT_ARGS);
});

test('headless: a found write is refused by name, and the model carries on', async t => {
  const chatId = newChatId('headless');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    search('comment'),
    toolTurn('jira__add_comment', COMMENT_ARGS, { id: 'call_2' }),
    textTurn('I could not comment.')
  ]);
  await turn(service, { chatId, prepData: prep(), headless: true });
  assert.equal(runTool.calls.length, 0);
  const message = toolMessageOf(requests[2], 'call_2');
  assert.equal(message.name, 'jira__add_comment');
  const payload = JSON.parse(message.content);
  assert.equal(payload.code, 'APPROVAL_REQUIRED_NO_USER');
  assert.match(payload.message, /"jira__add_comment"/);
});

test('a per-chat grant of the tool lets a found write run without asking', async t => {
  const chatId = newChatId('grant');
  captureFrames(t, chatId);
  const { service, runTool } = makeService([
    search('comment'),
    toolTurn('jira__add_comment', COMMENT_ARGS, { id: 'call_2' }),
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

/** The stored part of a turn that paused on a call to a found tool. */
const pausedTranscript = () => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_2',
        type: 'function',
        function: {
          name: 'jira__add_comment',
          arguments: JSON.stringify({ issue: 'SOMETHING-ELSE' })
        }
      }
    ]
  },
  {
    role: 'tool',
    tool_call_id: 'call_2',
    name: 'jira__add_comment',
    content: JSON.stringify({ status: 'awaiting_approval' })
  }
];

const resumeOf = (extra = {}) => ({
  interactionId: 'approve-1',
  outcome: 'approved',
  call: { id: 'call_2', name: 'jira__add_comment', toolId: 'jira__add_comment' },
  args: { issue: 'ACME-12', text: 'from the card' },
  transcript: pausedTranscript(),
  ...extra
});

test('approve: the call runs as the tool that was found, though this request left it out again', async t => {
  const chatId = newChatId('approve');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([textTurn('The comment was added.')]);
  const summary = await turn(service, {
    chatId,
    prepData: prep({
      llmMessages: [
        { role: 'user', content: 'Comment on ACME-12' },
        { role: 'user', content: 'Approved: jira__add_comment' }
      ]
    }),
    toolApproval: { grants: [], resume: resumeOf() }
  });

  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 1, 'run once, by the server');
  const [toolId, params] = runTool.calls[0];
  assert.equal(toolId, 'jira__add_comment');
  assert.equal(params.issue, 'ACME-12', 'the approved arguments win over what the model wrote');
  assert.equal(params.text, 'from the card');
  assert.equal(requests.length, 1, 'the model was not asked to issue the call again');
  assert.doesNotMatch(toolMessageOf(requests[0], 'call_2').content, /awaiting_approval/);
  assert.ok(sentToolNames(requests[0]).includes('jira__add_comment'), 'the tool is loaded now');
  assert.equal(ofType(frames, TOOL_STARTED)[0].data.toolId, 'jira__add_comment');
});

test('approve: a tool that is no longer offered is not run', async t => {
  const chatId = newChatId('gone');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([textTurn('Ok.')]);
  await turn(service, {
    chatId,
    prepData: prep({
      toolSearch: createToolSearch({ deferred: [] }),
      llmMessages: [{ role: 'user', content: 'Approved' }]
    }),
    toolApproval: { resume: resumeOf() }
  });
  assert.equal(runTool.calls.length, 0);
  assert.equal(
    JSON.parse(toolMessageOf(requests[0], 'call_2').content).reason,
    'tool_not_registered'
  );
});
