// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Resume the stored call after a connect (#3752), through
 * `ChatService.runTurn` on the real `AgentLoop` with a scripted provider and a
 * real chat store:
 *
 * - only a call that returned `INTEGRATION_AUTH_REQUIRED` for the tool's own
 *   installation leaves a record; adapter failures, a foreign installation,
 *   cut arguments, anonymous users and unstored turns leave none;
 * - the resume runs the stored call once, with its stored arguments, through
 *   the seams (an approval still asks), stores no user message, and the
 *   record is single use;
 * - another user, an expired record, a missing connection and any other
 *   message are handled before anything runs.
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
import {
  CONNECT_RESUME_TTL_MS,
  MAX_CONNECT_ARGS_CHARS,
  RESUME_LIMIT,
  buildPendingConnect,
  connectResumeMessages,
  loopResumeOf,
  parseConnectResume,
  prepareConnectResume,
  publicPendingConnect,
  resetResumeLimitForTests
} from '../../services/chat/chatConnectResume.js';
import { publicChatView } from '../../services/chat/chatToolApproval.js';
import { makeClient, sseResponse, MODELS } from './helpers/llmFixtures.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';

const sinks = new Map();
test.before(() => {
  setEnvelopeDelivery((streamId, envelope) => {
    sinks.get(streamId)?.push(stampSeq(streamId, envelope));
  });
});
test.after(() => setEnvelopeDelivery(routeEnvelope));
test.beforeEach(() => resetResumeLimitForTests());

function captureFrames(t, chatId) {
  const frames = [];
  sinks.set(chatId, frames);
  t.after(() => sinks.delete(chatId));
  return frames;
}

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

const AUTH_REQUIRED = {
  error: 'INTEGRATION_AUTH_REQUIRED',
  integration: 'jira',
  reason: 'not_connected',
  message: 'Connect Jira to use this tool.',
  connectUrl: '/api/integrations/jira/_connect'
};

/** A tool of the installation `jira`, as `getToolsForApp` offers an integration action. */
const JIRA_TOOL = {
  id: 'jira_search',
  name: 'jira_search',
  description: 'Search Jira',
  parameters: { type: 'object', properties: { jql: { type: 'string' } } },
  _integration: { instanceId: 'jira', instanceLabel: 'Jira', actionTitle: 'Search issues' }
};

function makeService(turns, { runTool, interactionService } = {}) {
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
  const runToolSpy = spy(runTool);
  const service = new ChatService({
    agentLoop: new AgentLoop({ llmClient: client, logger: silentLogger }),
    logInteraction: spy(async () => {}),
    runTool: runToolSpy,
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} },
    runLog: { startRun: async () => ({}), endRun: () => {}, append: () => {} },
    ...(interactionService ? { interactionService } : {})
  });
  return { service, requests, runTool: runToolSpy };
}

/** First call: not connected; every later call: a real result. */
function connectLater() {
  let first = true;
  return async (toolId, params) => {
    if (first) {
      first = false;
      return { ...AUTH_REQUIRED };
    }
    return { issues: [`ACME-1 for ${params.jql}`] };
  };
}

function prep(overrides = {}) {
  return {
    app: { id: 'app1' },
    model: MODELS.openai,
    llmMessages: [{ role: 'user', content: 'What are my open tickets?' }],
    tools: [JIRA_TOOL],
    maxTokens: 256,
    llmOptions: {},
    ...overrides
  };
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

const newChatId = label => `chat-connect-${label}-${crypto.randomUUID().slice(0, 8)}`;

async function chatStore(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'connect-resume-chats-'));
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

const persistenceFor = (repository, extra = {}) => ({
  repository,
  ownerId: 'u1',
  identityMode: 'default',
  content: 'What are my open tickets?',
  ...extra
});

const ARGS = { jql: 'assignee = currentUser()' };

/** The turn that fails on the missing connection, stored. */
async function failedTurn(t, { tool = JIRA_TOOL, runTool = connectLater(), args = ARGS } = {}) {
  const chatId = newChatId('failed');
  captureFrames(t, chatId);
  const repository = await chatStore(t);
  const {
    service,
    requests,
    runTool: runToolSpy
  } = makeService([toolTurn(tool.name, args), textTurn('Please connect Jira first.')], { runTool });
  const summary = await turn(service, {
    chatId,
    prepData: prep({ tools: [tool] }),
    persistence: persistenceFor(repository)
  });
  return { chatId, repository, service, requests, runTool: runToolSpy, summary };
}

const connected = async () => true;

/** Resume as the route does: prepare, commit, run the continuation turn. */
async function resumeTurn(t, setup, { user = { id: 'u1', groups: ['users'] }, ...options } = {}) {
  const { chatId, repository } = setup;
  const chat = await repository.getChat(chatId);
  const prepared = await prepareConnectResume({
    chatId,
    user,
    appId: 'app1',
    chat,
    ownerId: user.id,
    lastMessage: { connectResume: { id: chat.pendingConnect?.id ?? 'f'.repeat(32) } },
    repository,
    isConnected: connected,
    ...options.prepare
  });
  if (prepared.refusal) return { prepared };
  const committed = await prepared.commit();
  if (committed.refusal) return { prepared, committed };
  const next = makeService(options.script || [textTurn('You have one open ticket: ACME-1.')], {
    runTool: options.runTool || (async (id, params) => ({ issues: [`ACME-1 for ${params.jql}`] })),
    interactionService: options.interactionService
  });
  const summary = await turn(next.service, {
    chatId,
    prepData: prep({
      tools: options.tools || [JIRA_TOOL],
      llmMessages: [{ role: 'user', content: 'What are my open tickets?' }]
    }),
    persistence: persistenceFor(repository, { silent: true, content: '' }),
    connectResume: committed.resume,
    ...(options.turn || {})
  });
  return { prepared, committed, summary, ...next };
}

// ───────────────────────── the record ─────────────────────────

test('an own-installation auth failure leaves a record; the turn goes on as before', async t => {
  const { chatId, repository, summary, requests, runTool } = await failedTurn(t);
  assert.equal(summary.status, 'completed');
  assert.match(summary.content, /connect Jira/);
  assert.equal(runTool.calls.length, 1);
  assert.equal(requests.length, 2, 'the model still explained in the same turn');

  const { pendingConnect: record } = await repository.getChat(chatId);
  assert.match(record.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(record.integrations, ['jira']);
  assert.equal(record.calls.length, 1);
  assert.deepEqual(record.calls[0], {
    id: 'call_1',
    name: 'jira_search',
    toolId: 'jira_search',
    integration: 'jira',
    reason: 'not_connected',
    args: ARGS
  });
  assert.equal(record.runId, summary.runId);
  assert.equal(Date.parse(record.expiresAt) - Date.parse(record.createdAt), CONNECT_RESUME_TTL_MS);
  // The step that made the call, not the explanation that followed it.
  const roles = record.transcript.map(m => m.role);
  assert.deepEqual(roles, ['assistant', 'tool']);
  assert.match(record.transcript[1].content, /INTEGRATION_AUTH_REQUIRED/);
});

test('the client sees the id and integrations, never the arguments or the transcript', async t => {
  const { chatId, repository } = await failedTurn(t);
  const chat = await repository.getChat(chatId);
  const view = publicChatView(chat);
  assert.deepEqual(Object.keys(view.pendingConnect).sort(), [
    'callIds',
    'expiresAt',
    'id',
    'integrations'
  ]);
  assert.deepEqual(view.pendingConnect.callIds, ['call_1']);
  assert.doesNotMatch(JSON.stringify(view), /assignee|transcript/);
  assert.equal(publicChatView({ id: 'x' }).pendingConnect, undefined);
  assert.equal(publicPendingConnect(null), null);
});

test('a result that names another installation than the tool leaves no record', async t => {
  const setup = await failedTurn(t, {
    runTool: async () => ({ ...AUTH_REQUIRED, integration: 'okta' })
  });
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
});

test('a tool that belongs to no installation leaves no record, whatever its result says', async t => {
  const plain = { ...JIRA_TOOL, _integration: undefined };
  const setup = await failedTurn(t, { tool: plain });
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
});

test('a failure inside the adapter or on the transport leaves no record', async t => {
  for (const runTool of [
    async () => {
      throw new Error('socket hang up');
    },
    async () => ({ error: true, message: 'Jira answered 500' }),
    async () => ({ error: 'JIRA_ERROR', integration: 'jira' })
  ]) {
    const setup = await failedTurn(t, { runTool });
    assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
  }
});

test('arguments that were cut or are too long leave no record (fail closed)', async t => {
  const big = { jql: 'x'.repeat(MAX_CONNECT_ARGS_CHARS + 10) };
  const setup = await failedTurn(t, { args: big });
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
});

test('an anonymous user, or a turn that is not stored, leaves no record', async t => {
  const chatId = newChatId('anon');
  captureFrames(t, chatId);
  const repository = await chatStore(t);
  const { service } = makeService([toolTurn('jira_search', ARGS), textTurn('Connect please.')], {
    runTool: connectLater()
  });
  await turn(service, {
    chatId,
    prepData: prep(),
    persistence: persistenceFor(repository),
    user: { id: 'anonymous', groups: ['anonymous'] }
  });
  assert.ok(!(await repository.getChat(chatId)).pendingConnect);

  const second = makeService([toolTurn('jira_search', ARGS), textTurn('Connect please.')], {
    runTool: connectLater()
  });
  const summary = await turn(second.service, { chatId: newChatId('nostore'), prepData: prep() });
  assert.equal(summary.status, 'completed');
});

test('buildPendingConnect: more calls than the cap, or none, is not resumable', () => {
  const call = n => ({
    id: `c${n}`,
    name: 't',
    toolId: 't',
    integration: 'jira',
    reason: 'not_connected',
    args: {}
  });
  assert.equal(
    buildPendingConnect({ runId: 'r', calls: [], messages: [], startMessage: null }),
    null
  );
  const many = Array.from({ length: 6 }, (_, n) => call(n));
  assert.equal(
    buildPendingConnect({ runId: 'r', calls: many, messages: [], startMessage: null }),
    null
  );
});

// ───────────────────────── the resume ─────────────────────────

test('after a connect the stored call runs once with its stored arguments, and no user message is stored', async t => {
  const setup = await failedTurn(t);
  const before = (await setup.repository.getMessages(setup.chatId)).messages;
  assert.deepEqual(
    before.map(m => m.role),
    ['user', 'assistant']
  );

  const resumed = await resumeTurn(t, setup);
  assert.equal(resumed.summary.status, 'completed');
  assert.equal(resumed.runTool.calls.length, 1, 'the call ran exactly once');
  assert.deepEqual(resumed.runTool.calls[0][0], 'jira_search');
  assert.equal(resumed.runTool.calls[0][1].jql, ARGS.jql, 'the stored arguments, not new ones');
  // The model continued from the real result (one request, no second tool call).
  assert.equal(resumed.requests.length, 1);
  const toolMessage = resumed.requests[0].body.messages.find(m => m.role === 'tool');
  assert.match(toolMessage.content, /ACME-1/);
  assert.doesNotMatch(toolMessage.content, /INTEGRATION_AUTH_REQUIRED/);
  // No synthetic message: the history holds no extra user message, and the
  // continuation is a new assistant message after the earlier answer.
  const after = (await setup.repository.getMessages(setup.chatId)).messages;
  assert.deepEqual(
    after.map(m => m.role),
    ['user', 'assistant', 'assistant']
  );
  assert.match(after[2].content, /ACME-1/);
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
  const userMessages = resumed.requests[0].body.messages.filter(m => m.role === 'user');
  assert.equal(userMessages.length, 1, 'only the original question');
});

test('the record is single use: of two requests exactly one runs the call', async t => {
  const setup = await failedTurn(t);
  const chat = await setup.repository.getChat(setup.chatId);
  const request = () =>
    prepareConnectResume({
      chatId: setup.chatId,
      user: { id: 'u1' },
      appId: 'app1',
      chat,
      ownerId: 'u1',
      lastMessage: { connectResume: { id: chat.pendingConnect.id } },
      repository: setup.repository,
      isConnected: connected
    }).then(prepared => prepared.commit());
  const results = await Promise.all([request(), request(), request()]);
  assert.equal(results.filter(r => r.resume).length, 1);
  const refused = results.filter(r => r.refusal);
  assert.equal(refused.length, 2);
  assert.ok(
    refused.every(r => r.refusal.status === 409 && r.refusal.code === 'CONNECT_RESUME_NOT_PENDING')
  );
});

test('a turn refused before its loop started puts the record back; after that it never does', async t => {
  const setup = await failedTurn(t);
  const chat = await setup.repository.getChat(setup.chatId);
  const prepared = await prepareConnectResume({
    chatId: setup.chatId,
    user: { id: 'u1' },
    appId: 'app1',
    chat,
    ownerId: 'u1',
    lastMessage: { connectResume: { id: chat.pendingConnect.id } },
    repository: setup.repository,
    isConnected: connected
  });
  const committed = await prepared.commit();
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
  assert.equal(await committed.restore(), true);
  assert.equal(
    (await setup.repository.getChat(setup.chatId)).pendingConnect.id,
    chat.pendingConnect.id
  );
});

test('a call that needs approval asks after the connect; it does not run', async t => {
  const gated = { ...JIRA_TOOL, approval: 'always', approvalSource: 'tool', sideEffect: 'write' };
  // First turn: the chat already allows the tool, so it reaches the connection check.
  const chatId = newChatId('approval');
  captureFrames(t, chatId);
  const repository = await chatStore(t);
  const first = makeService([toolTurn('jira_search', ARGS), textTurn('Connect Jira.')], {
    runTool: connectLater()
  });
  await turn(first.service, {
    chatId,
    prepData: prep({ tools: [gated] }),
    persistence: persistenceFor(repository),
    toolApproval: { grants: ['jira_search'] }
  });
  assert.ok((await repository.getChat(chatId)).pendingConnect, 'the record exists');

  // The resume carries no grant and no approved call: the policy asks.
  const storage = await startTestStorage({ prefix: 'connect-resume-' });
  const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
  const interactionService = new InteractionService({ runLog });
  t.after(async () => {
    await interactionService.stop?.();
    await storage.stop();
  });
  const frames = [];
  sinks.set(chatId, frames);
  const resumed = await resumeTurn(
    t,
    { chatId, repository },
    {
      tools: [gated],
      interactionService,
      script: [],
      turn: { canApproveTools: true }
    }
  );
  assert.equal(resumed.summary.status, 'paused');
  assert.equal(resumed.summary.finishReason, 'approval');
  assert.equal(resumed.runTool.calls.length, 0, 'nothing ran before the person approved');
  assert.equal(resumed.summary.pendingInteraction.kind, 'approval');
  assert.deepEqual(resumed.summary.pendingInteraction.prompt.displayData.args, ARGS);
});

test('a call that fails with the auth result again is not run a second time, and leaves a new record', async t => {
  const setup = await failedTurn(t);
  const resumed = await resumeTurn(t, setup, {
    runTool: async () => ({ ...AUTH_REQUIRED }),
    script: [textTurn('Still not connected.')]
  });
  assert.equal(resumed.runTool.calls.length, 1, 'one run, no automatic second resume');
  const record = (await setup.repository.getChat(setup.chatId)).pendingConnect;
  assert.ok(record, 'a new record for the new card');
  assert.notEqual(record.id, resumed.prepared.record.id);
});

test('a tool that is no longer offered does not run', async t => {
  const setup = await failedTurn(t);
  const resumed = await resumeTurn(t, setup, {
    tools: [],
    script: [textTurn('That tool is gone.')]
  });
  assert.equal(resumed.runTool.calls.length, 0);
});

// ───────────────────────── refusals ─────────────────────────

async function preparing(
  setup,
  {
    user = { id: 'u1' },
    ownerId = user.id,
    lastMessage,
    now,
    isConnected = connected,
    appId = 'app1'
  } = {}
) {
  const chat = await setup.repository.getChat(setup.chatId);
  return prepareConnectResume({
    chatId: setup.chatId,
    user,
    appId,
    chat,
    ownerId,
    lastMessage: lastMessage || {
      connectResume: { id: chat.pendingConnect?.id ?? 'e'.repeat(32) }
    },
    repository: setup.repository,
    isConnected,
    ...(now ? { now } : {})
  });
}

test('another user, an anonymous user, another app and an unknown id get the same "nothing pending"', async t => {
  const setup = await failedTurn(t);
  const cases = [
    await preparing(setup, { user: { id: 'u2' } }),
    await preparing(setup, { user: { id: 'anonymous' }, ownerId: 'anonymous' }),
    await preparing(setup, { appId: 'other-app' }),
    await preparing(setup, { lastMessage: { connectResume: { id: 'd'.repeat(32) } } })
  ];
  for (const prepared of cases) {
    assert.equal(prepared.refusal.status, 409);
    assert.equal(prepared.refusal.code, 'CONNECT_RESUME_NOT_PENDING');
    assert.equal(prepared.commit, null);
  }
  assert.ok((await setup.repository.getChat(setup.chatId)).pendingConnect, 'nothing was taken');
});

test('a connectResume that is not a record id is a 400', async t => {
  const setup = await failedTurn(t);
  for (const raw of ['x', { id: 'short' }, { id: 5 }, [], { id: `${'a'.repeat(31)}/` }]) {
    const prepared = await preparing(setup, { lastMessage: { connectResume: raw } });
    assert.equal(prepared.refusal.status, 400);
    assert.equal(prepared.refusal.code, 'INVALID_CONNECT_RESUME');
  }
  assert.equal(parseConnectResume({ id: 'a'.repeat(32) }).id, 'a'.repeat(32));
});

test('an expired record is a 410 and is dropped', async t => {
  const setup = await failedTurn(t);
  const later = new Date(Date.now() + CONNECT_RESUME_TTL_MS + 1000);
  const prepared = await preparing(setup, { now: later });
  assert.equal(prepared.refusal.status, 410);
  assert.equal(prepared.refusal.code, 'CONNECT_RESUME_EXPIRED');
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
});

test('a connection that is not usable yet refuses and keeps the record (the card stays)', async t => {
  const setup = await failedTurn(t);
  const asked = [];
  const prepared = await preparing(setup, {
    isConnected: async (userId, integration) => {
      asked.push([userId, integration]);
      return false;
    }
  });
  assert.equal(prepared.refusal.status, 409);
  assert.equal(prepared.refusal.code, 'CONNECT_RESUME_NOT_CONNECTED');
  assert.deepEqual(asked, [['u1', 'jira']], "the acting user and the record's integration");
  assert.ok((await setup.repository.getChat(setup.chatId)).pendingConnect);
});

test('any other message supersedes the record', async t => {
  const setup = await failedTurn(t);
  const prepared = await preparing(setup, { lastMessage: { content: 'never mind' } });
  assert.equal(prepared.refusal, null);
  assert.equal(prepared.commit, null);
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
});

test('resume requests are rate limited per user, refused ones included', async t => {
  const setup = await failedTurn(t);
  let last;
  for (let n = 0; n <= RESUME_LIMIT; n++) {
    last = await preparing(setup, { lastMessage: { connectResume: { id: 'c'.repeat(32) } } });
  }
  assert.equal(last.refusal.status, 429);
  assert.equal(last.refusal.code, 'RATE_LIMITED');
});

// ───────────────────────── helpers ─────────────────────────

test('connectResumeMessages appends the stored step after the history and does not drop the question', () => {
  const history = [{ role: 'user', content: 'Q' }];
  const transcript = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: '{}' }
  ];
  const out = connectResumeMessages(history, transcript);
  assert.deepEqual(
    out.map(m => m.role),
    ['user', 'assistant', 'tool']
  );
  assert.equal(out[0].content, 'Q');
  // An app without chat history: the stored question is put back in front.
  assert.equal(connectResumeMessages([], transcript, { question: 'Q2' })[0].content, 'Q2');
  const resume = loopResumeOf([{ id: 'c1', name: 'n', args: { a: 1 } }]);
  assert.deepEqual(resume.toolCalls[0].args, { a: 1 });
  assert.equal(resume.toolCalls[0].toolCall.function.arguments, '{"a":1}');
});

// ───────────────────────── review follow-ups ─────────────────────────

test('a headless turn (the inference API) or a temporary chat leaves no record', async t => {
  for (const extra of [{ headless: true }, { persistence: { temporary: true } }]) {
    const chatId = newChatId('nokeep');
    captureFrames(t, chatId);
    const repository = await chatStore(t);
    const { service } = makeService([toolTurn('jira_search', ARGS), textTurn('Connect please.')], {
      runTool: connectLater()
    });
    await turn(service, {
      chatId,
      prepData: prep(),
      ...extra,
      persistence: { ...persistenceFor(repository), ...(extra.persistence || {}) }
    });
    assert.ok(!(await repository.getChat(chatId))?.pendingConnect);
  }
});

test('a resume that fails again chains: the next resume drops every answer of the chain', async t => {
  const setup = await failedTurn(t);
  const first = (await setup.repository.getChat(setup.chatId)).pendingConnect;
  const resumed = await resumeTurn(t, setup, {
    runTool: async () => ({ ...AUTH_REQUIRED }),
    script: [textTurn('Still not connected.')]
  });
  assert.deepEqual(resumed.committed.resume.answerRunIds, [first.runId]);
  const second = (await setup.repository.getChat(setup.chatId)).pendingConnect;
  assert.deepEqual(second.continues, [first.runId]);
  const prepared = await preparing(setup);
  const committed = await prepared.commit();
  assert.deepEqual(committed.resume.answerRunIds, [first.runId, second.runId]);
});

test('connectResume together with an approval answer is refused; an expired record is not offered', async t => {
  const setup = await failedTurn(t);
  const chat = await setup.repository.getChat(setup.chatId);
  const both = await preparing(setup, {
    lastMessage: {
      connectResume: { id: chat.pendingConnect.id },
      approvalResponse: { interactionId: 'x', decision: 'approve' }
    }
  });
  assert.equal(both.refusal.code, 'INVALID_CONNECT_RESUME');
  assert.ok(publicPendingConnect(chat.pendingConnect));
  assert.equal(
    publicPendingConnect(chat.pendingConnect, Date.now() + CONNECT_RESUME_TTL_MS + 1),
    null
  );
});

// ───────────────────────── CodeRabbit follow-ups ─────────────────────────

test('a turn that went on to run another tool after the failed call is not resumable', async t => {
  const chatId = newChatId('later');
  captureFrames(t, chatId);
  const repository = await chatStore(t);
  const other = {
    id: 'other_write',
    name: 'other_write',
    description: 'Writes',
    parameters: { type: 'object', properties: {} }
  };
  const { service } = makeService(
    [
      toolTurn('jira_search', ARGS),
      toolTurn('other_write', {}, { id: 'call_2' }),
      textTurn('Done.')
    ],
    {
      runTool: async toolId => (toolId === 'jira_search' ? { ...AUTH_REQUIRED } : { written: true })
    }
  );
  await turn(service, {
    chatId,
    prepData: prep({ tools: [JIRA_TOOL, other] }),
    persistence: persistenceFor(repository)
  });
  assert.ok(!(await repository.getChat(chatId))?.pendingConnect, 'the write may have run');
});

test('a record that expired between the checks and the take does not run', async t => {
  const setup = await failedTurn(t);
  const chat = await setup.repository.getChat(setup.chatId);
  const prepared = await preparing(setup);
  assert.equal(prepared.refusal, null);
  await setup.repository.updateChat(setup.chatId, {
    pendingConnect: { ...chat.pendingConnect, expiresAt: new Date(Date.now() - 1000).toISOString() }
  });
  const committed = await prepared.commit();
  assert.equal(committed.refusal.code, 'CONNECT_RESUME_EXPIRED');
  assert.equal(committed.resume, null);
});

test('a run that no longer owns the chat does not leave its record behind', async t => {
  const setup = await failedTurn(t);
  const { pendingConnect: record } = await setup.repository.getChat(setup.chatId);
  await setup.repository.updateChat(setup.chatId, {
    pendingConnect: null,
    activeRunId: 'chat-newer-run'
  });
  assert.equal(await setup.repository.setPendingConnect(setup.chatId, record.runId, record), false);
  assert.ok(!(await setup.repository.getChat(setup.chatId)).pendingConnect);
});

// ───────────────────────── audit ─────────────────────────

test('a resume is audited once, with ids and tool names and never the arguments', async t => {
  const setup = await failedTurn(t);
  const chat = await setup.repository.getChat(setup.chatId);
  const entries = [];
  const request = () =>
    prepareConnectResume({
      chatId: setup.chatId,
      user: { id: 'u1' },
      appId: 'app1',
      chat,
      ownerId: 'u1',
      lastMessage: { connectResume: { id: chat.pendingConnect.id } },
      repository: setup.repository,
      isConnected: connected,
      req: { ip: '127.0.0.1' },
      audit: entry => entries.push(entry)
    }).then(prepared => prepared.commit());
  // Two requests at once: one takes the record, only that one is audited.
  await Promise.all([request(), request()]);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.action, 'execute');
  assert.equal(entry.resource, 'connection');
  assert.equal(entry.resourceId, 'jira:u1');
  assert.deepEqual(entry.details.toolIds, ['jira_search']);
  assert.equal(entry.details.event, 'connection.resume');
  assert.equal(entry.details.chatId, setup.chatId);
  assert.doesNotMatch(JSON.stringify(entry), /assignee|currentUser/);
});

test('a refused resume (not connected, expired, another user) is not audited', async t => {
  const setup = await failedTurn(t);
  const entries = [];
  const chat = await setup.repository.getChat(setup.chatId);
  const base = {
    chatId: setup.chatId,
    appId: 'app1',
    chat,
    repository: setup.repository,
    lastMessage: { connectResume: { id: chat.pendingConnect.id } },
    audit: entry => entries.push(entry)
  };
  await prepareConnectResume({
    ...base,
    user: { id: 'u1' },
    ownerId: 'u1',
    isConnected: async () => false
  });
  await prepareConnectResume({
    ...base,
    user: { id: 'u2' },
    ownerId: 'u2',
    isConnected: connected
  });
  await prepareConnectResume({
    ...base,
    user: { id: 'u1' },
    ownerId: 'u1',
    isConnected: connected,
    now: new Date(Date.now() + CONNECT_RESUME_TTL_MS + 1000)
  });
  assert.deepEqual(entries, []);
});

test('a call the model made again in a later step is stored once: only the last failing step', async t => {
  const chatId = newChatId('retry');
  captureFrames(t, chatId);
  const repository = await chatStore(t);
  const { service, runTool } = makeService(
    [
      toolTurn('jira_search', ARGS, { id: 'call_1' }),
      toolTurn('jira_search', { jql: 'corrected' }, { id: 'call_2' }),
      textTurn('Please connect Jira.')
    ],
    { runTool: async () => ({ ...AUTH_REQUIRED }) }
  );
  await turn(service, {
    chatId,
    prepData: prep(),
    persistence: persistenceFor(repository)
  });
  assert.equal(runTool.calls.length, 2, 'the model tried twice');
  const record = (await repository.getChat(chatId)).pendingConnect;
  assert.deepEqual(
    record.calls.map(c => c.id),
    ['call_2']
  );
  assert.deepEqual(record.calls[0].args, { jql: 'corrected' });
});
