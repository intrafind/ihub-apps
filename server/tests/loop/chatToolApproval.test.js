// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat tool approval (#2945), end to end through `ChatService.runTurn` on the
 * real `AgentLoop` with a scripted provider:
 *
 * - the approval seam runs before every other seam: a gated call raises an
 *   `approval` interaction, never shows as started, never runs, and the turn
 *   pauses (`finishReason: 'approval'`);
 * - headless (or a client that cannot draw the card): the model gets
 *   `APPROVAL_REQUIRED_NO_USER` and carries on;
 * - continuation: on approve the SERVER runs the stored call with exactly the
 *   approved arguments (not what the model wrote) and the result replaces the
 *   placeholder; reject / expiry become `USER_REJECTED` / `APPROVAL_EXPIRED`;
 * - `settleChatApprovals`: answers once (a double answer is refused), records
 *   the per-chat grant, supersedes on any other message, expires.
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
import {
  continuationMessages,
  pausedTurnTranscript,
  publicChatView,
  settleChatApprovals
} from '../../services/chat/chatToolApproval.js';
import { makeClient, sseResponse, MODELS } from './helpers/llmFixtures.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';

const { INTERACTION_RAISED, TOOL_STARTED, TOOL_COMPLETED, RUN_PAUSED, RUN_ENDED, KNOWLEDGE_SCOPE } =
  SSE_V2_EVENTS;

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

function toolTurn(name, args, { id = 'call_1', content = '' } = {}) {
  return [
    ...(content
      ? [{ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }]
      : []),
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

async function interactionsFor(t) {
  const storage = await startTestStorage({ prefix: 'tool-approval-' });
  const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog });
  t.after(async () => {
    await svc.stop?.();
    await storage.stop();
  });
  return svc;
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
    runLog: { startRun: async () => ({}), endRun: () => {}, append: () => {} },
    ...(interactionService ? { interactionService } : {})
  });
  return { service, requests, runTool: runToolSpy };
}

/** A tool as `getToolsForApp` offers it: stamped with its resolved approval policy. */
const GATED = {
  id: 'dangerous',
  name: 'dangerous',
  description: 'Changes something',
  parameters: { type: 'object', properties: { target: { type: 'string' } } },
  approval: 'always',
  approvalSource: 'tool',
  sideEffect: 'write',
  sideEffectSource: 'tool',
  dataFlow: 'external'
};

function prep(overrides = {}) {
  return {
    app: { id: 'app1' },
    model: MODELS.openai,
    llmMessages: [{ role: 'user', content: 'Please change ACME-12' }],
    tools: [GATED],
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

const newChatId = label => `chat-approval-${label}-${crypto.randomUUID().slice(0, 8)}`;

/** A real chat store over a scratch directory, and the order of its approval writes. */
async function chatStore(t, events = []) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-approval-chats-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: silentLogger
  });
  const updateChat = repository.updateChat.bind(repository);
  repository.updateChat = async (chatId, patch) => {
    if (patch?.toolApproval?.pending) events.push('pending-stored');
    return updateChat(chatId, patch);
  };
  t.after(async () => {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return repository;
}

const persistenceFor = repository => ({
  repository,
  ownerId: 'u1',
  identityMode: 'default',
  content: 'Please change ACME-12'
});

test('a gated call raises an approval and pauses; it never starts and never runs', async t => {
  const chatId = newChatId('pause');
  const order = [];
  const frames = captureFrames(t, chatId);
  const sink = sinks.get(chatId);
  sinks.set(chatId, {
    push: frame => {
      if (frame.type === INTERACTION_RAISED) order.push('raised');
      return sink.push(frame);
    }
  });
  const repository = await chatStore(t, order);
  const interactionService = await interactionsFor(t);
  const { service, runTool, requests } = makeService(
    [toolTurn('dangerous', { target: 'ACME-12' }, { content: 'I will update the ticket.' })],
    { interactionService }
  );
  const summary = await turn(service, {
    chatId,
    prepData: prep(),
    persistence: persistenceFor(repository)
  });

  // The card is only shown once an answer to it can be accepted (review #5).
  assert.deepEqual(order, ['pending-stored', 'raised']);
  const stored = (await repository.getChat(chatId)).toolApproval.pending;
  assert.equal(stored.call.id, 'call_1');
  assert.deepEqual(stored.call.args, { target: 'ACME-12' });

  assert.equal(summary.status, 'paused');
  assert.equal(summary.finishReason, 'approval');
  assert.equal(requests.length, 1, 'one model call, then the pause');
  assert.equal(runTool.calls.length, 0, 'the gated tool did not run');
  assert.equal(ofType(frames, TOOL_STARTED).length, 0, 'no tool/started for a gated call');
  assert.equal(ofType(frames, RUN_PAUSED).length, 1);

  const [raised] = ofType(frames, INTERACTION_RAISED);
  const interaction = raised.data.interaction;
  assert.equal(interaction.kind, 'approval');
  assert.equal(interaction.origin, 'tool');
  assert.equal(interaction.source.chatId, chatId);
  assert.equal(interaction.source.toolCallId, 'call_1');
  assert.deepEqual(interaction.prompt.displayData.args, { target: 'ACME-12' });
  assert.equal(interaction.prompt.displayData.sideEffect, 'write');
  assert.equal(interaction.prompt.displayData.dataFlow, 'external');
  assert.equal(interaction.prompt.displayData.justification, 'I will update the ticket.');
  assert.equal(summary.pendingInteraction.id, interaction.id);
  // The placeholder the continuation replaces is in the stored transcript.
  const placeholder = stored.transcript.find(m => m.role === 'tool');
  assert.match(placeholder.content, /awaiting_approval/);
});

test('a pause that cannot be kept with the chat shows no card and cancels the approval', async t => {
  const chatId = newChatId('unstored');
  const frames = captureFrames(t, chatId);
  const repository = await chatStore(t);
  repository.updateChat = async () => null;
  const interactionService = await interactionsFor(t);
  const { service } = makeService([toolTurn('dangerous', { target: 'ACME-12' })], {
    interactionService
  });
  const summary = await turn(service, {
    chatId,
    prepData: prep(),
    persistence: persistenceFor(repository)
  });
  assert.equal(ofType(frames, INTERACTION_RAISED).length, 0);
  const [done] = ofType(frames, TOOL_COMPLETED);
  assert.equal(done.data.error.code, 'APPROVAL_NOT_STORED');
  assert.equal((await interactionService.get(summary.pendingInteraction.id)).status, 'cancelled');
});

test('a turn that is not stored cannot pause: it refuses like a headless one', async t => {
  const chatId = newChatId('nostore');
  captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([
    toolTurn('dangerous', { target: 'A' }),
    textTurn('Not possible here.')
  ]);
  const summary = await turn(service, { chatId, prepData: prep() });
  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 0);
  const toolMessage = requests[1].body.messages.find(m => m.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).code, 'APPROVAL_REQUIRED_NO_USER');
});

test('headless, or a client that cannot draw the card: APPROVAL_REQUIRED_NO_USER and the model carries on', async t => {
  for (const options of [{ headless: true }, { canApproveTools: false }]) {
    const chatId = newChatId('headless');
    const frames = captureFrames(t, chatId);
    const { service, runTool, requests } = makeService([
      toolTurn('dangerous', { target: 'ACME-12' }),
      textTurn('I could not change it without approval.')
    ]);
    const summary = await turn(service, { chatId, prepData: prep(), ...options });
    assert.equal(summary.status, 'completed');
    assert.equal(runTool.calls.length, 0);
    const toolMessage = requests[1].body.messages.find(m => m.role === 'tool');
    assert.equal(JSON.parse(toolMessage.content).code, 'APPROVAL_REQUIRED_NO_USER');
    if (!options.headless) {
      const [done] = ofType(frames, TOOL_COMPLETED);
      assert.equal(done.data.error.code, 'APPROVAL_REQUIRED_NO_USER');
    }
  }
});

test('a per-chat grant lets the tool run without asking', async t => {
  const chatId = newChatId('grant');
  captureFrames(t, chatId);
  const { service, runTool } = makeService([
    toolTurn('dangerous', { target: 'A' }),
    textTurn('Done.')
  ]);
  const summary = await turn(service, {
    chatId,
    prepData: prep(),
    toolApproval: { grants: ['dangerous'] }
  });
  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 1);
});

/** The stored part of a paused turn: the model's call and the placeholder. */
function pausedTranscript(modelArgs) {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'dangerous', arguments: JSON.stringify(modelArgs) }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'dangerous',
      content: JSON.stringify({ status: 'awaiting_approval' })
    }
  ];
}

test('approve: the server runs the stored call with exactly the approved arguments, then the model continues', async t => {
  const chatId = newChatId('approve');
  const frames = captureFrames(t, chatId);
  const { service, runTool, requests } = makeService([textTurn('The ticket was updated.')]);
  const approvedArgs = { target: 'ACME-12', note: 'from the card' };
  const summary = await turn(service, {
    chatId,
    prepData: prep({
      llmMessages: [
        { role: 'user', content: 'Please change ACME-12' },
        { role: 'user', content: 'Approved: dangerous' }
      ]
    }),
    toolApproval: {
      grants: [],
      resume: {
        interactionId: 'approve-1',
        outcome: 'approved',
        call: { id: 'call_1', name: 'dangerous', toolId: 'dangerous' },
        args: approvedArgs,
        // What the model wrote differs: the approved arguments win.
        transcript: pausedTranscript({ target: 'SOMETHING-ELSE' })
      }
    }
  });

  assert.equal(summary.status, 'completed');
  assert.equal(runTool.calls.length, 1, 'run once, by the server');
  const [toolId, params] = runTool.calls[0];
  assert.equal(toolId, 'dangerous');
  assert.equal(params.target, 'ACME-12');
  assert.equal(params.note, 'from the card');
  assert.equal(requests.length, 1, 'the model was not asked to issue the call again');

  const sent = requests[0].body.messages;
  assert.ok(
    !sent.some(m => m.role === 'user' && m.content === 'Approved: dangerous'),
    'the decision message is not part of the prompt'
  );
  const toolMessage = sent.find(m => m.role === 'tool' && m.tool_call_id === 'call_1');
  assert.doesNotMatch(toolMessage.content, /awaiting_approval/, 'the placeholder was replaced');
  assert.equal(JSON.parse(toolMessage.content).ok, true);
  assert.equal(ofType(frames, TOOL_STARTED).length, 1, 'the approved call shows as started');
});

test('reject and expiry: the placeholder becomes USER_REJECTED / APPROVAL_EXPIRED; nothing runs', async t => {
  for (const [outcome, code] of [
    ['rejected', 'USER_REJECTED'],
    ['expired', 'APPROVAL_EXPIRED']
  ]) {
    const chatId = newChatId(outcome);
    const frames = captureFrames(t, chatId);
    const { service, runTool, requests } = makeService([textTurn('Understood.')]);
    await turn(service, {
      chatId,
      prepData: prep({
        llmMessages: [
          { role: 'user', content: 'Please change ACME-12' },
          { role: 'user', content: 'Rejected: dangerous' }
        ]
      }),
      toolApproval: {
        resume: {
          interactionId: 'approve-2',
          outcome,
          call: { id: 'call_1', name: 'dangerous', toolId: 'dangerous' },
          args: { target: 'ACME-12' },
          transcript: pausedTranscript({ target: 'ACME-12' })
        }
      }
    });
    assert.equal(runTool.calls.length, 0);
    const toolMessage = requests[0].body.messages.find(m => m.role === 'tool');
    assert.equal(JSON.parse(toolMessage.content).code, code);
    const [done] = ofType(frames, TOOL_COMPLETED);
    assert.equal(done.data.error.code, code);
  }
});

// ── the answer basis across an approval ─────────────────────────────────────

const SEARCH = {
  id: 'webSearch',
  name: 'webSearch',
  script: 'braveSearch.js',
  description: 'search the web',
  parameters: { type: 'object', properties: { query: { type: 'string' } } }
};

test('a pause keeps what the turn had used so far with the approval', async t => {
  const chatId = newChatId('basis-pause');
  captureFrames(t, chatId);
  const repository = await chatStore(t);
  const interactionService = await interactionsFor(t);
  const { service } = makeService(
    [toolTurn('webSearch', { query: 'acme' }), toolTurn('dangerous', { target: 'ACME-12' })],
    { interactionService }
  );
  const summary = await turn(service, {
    chatId,
    prepData: prep({ tools: [SEARCH, GATED] }),
    persistence: persistenceFor(repository)
  });
  assert.equal(summary.status, 'paused');
  const stored = (await repository.getChat(chatId)).toolApproval.pending;
  assert.deepEqual(stored.basis.knowledgeSources, ['websearch']);
  assert.deepEqual(stored.basis.integrations, []);
  assert.deepEqual(stored.basis.projectsRead, []);
});

test('the answer after an approval is based on the whole turn, not on the approved call alone', async t => {
  for (const outcome of ['approved', 'rejected']) {
    const chatId = newChatId(`basis-${outcome}`);
    const frames = captureFrames(t, chatId);
    const { service } = makeService([textTurn('Done.')]);
    const knowledgeScope = {
      projects: [
        { id: 'prj_a', name: 'Alpha', mode: 'searched', contributed: false },
        { id: 'prj_b', name: 'Beta', mode: 'searched', contributed: false }
      ]
    };
    const summary = await turn(service, {
      chatId,
      prepData: prep({
        llmMessages: [
          { role: 'user', content: 'Please change ACME-12' },
          { role: 'user', content: 'Decision' }
        ],
        knowledgeScope
      }),
      toolApproval: {
        grants: [],
        resume: {
          interactionId: `basis-${outcome}`,
          outcome,
          call: { id: 'call_1', name: 'dangerous', toolId: 'dangerous' },
          args: { target: 'ACME-12' },
          transcript: pausedTranscript({ target: 'ACME-12' }),
          // What the turn had used before an approval paused it.
          basis: {
            knowledgeSources: ['project', 'websearch', 'integration'],
            integrations: ['Jira'],
            projectsRead: ['prj_a']
          }
        }
      }
    });
    const expected = [{ kind: 'project' }, { kind: 'web' }, { kind: 'integration', label: 'Jira' }];
    assert.deepEqual(ofType(frames, RUN_ENDED)[0].data.answerBasis, expected, outcome);
    assert.deepEqual(summary.answerBasis, expected, outcome);
    // The project read before the pause contributed; the other one did not.
    const scopes = ofType(frames, KNOWLEDGE_SCOPE).map(f => f.data);
    assert.deepEqual(
      scopes.at(-1).projects.map(p => [p.id, p.contributed]),
      [
        ['prj_a', true],
        ['prj_b', false]
      ],
      outcome
    );
  }
});

test('without a carried basis the continuation is named by what it used itself', async t => {
  const chatId = newChatId('basis-none');
  const frames = captureFrames(t, chatId);
  const { service } = makeService([textTurn('Done.')]);
  await turn(service, {
    chatId,
    prepData: prep({
      llmMessages: [
        { role: 'user', content: 'Please change ACME-12' },
        { role: 'user', content: 'Decision' }
      ]
    }),
    toolApproval: {
      resume: {
        interactionId: 'basis-none',
        outcome: 'rejected',
        call: { id: 'call_1', name: 'dangerous', toolId: 'dangerous' },
        args: {},
        transcript: pausedTranscript({ target: 'ACME-12' })
      }
    }
  });
  assert.deepEqual(ofType(frames, RUN_ENDED)[0].data.answerBasis, [{ kind: 'model' }]);
});

test('settle: the carried basis is handed to the continuation, bounded to strings', async t => {
  const svc = await interactionsFor(t);
  const chatId = 'chat-settle-basis';
  const interaction = await raiseChatApproval(svc, chatId);
  const chat = storedChat(interaction);
  chat.toolApproval.pending.basis = {
    knowledgeSources: ['websearch', 42, { x: 1 }],
    integrations: ['Jira', ''],
    projectsRead: ['prj_a'],
    leftover: 'dropped'
  };
  const result = await settleChatApprovals({
    chatId,
    user: { id: 'u1' },
    chat,
    lastMessage: {
      role: 'user',
      approvalResponse: { interactionId: interaction.id, decision: 'approve' }
    },
    repository: fakeRepository(),
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.deepEqual(result.resume.basis, {
    knowledgeSources: ['websearch'],
    integrations: ['Jira', ''],
    projectsRead: ['prj_a']
  });
});

// ── settling the answer ─────────────────────────────────────────────────────

function fakeRepository() {
  const updates = [];
  return { updates, updateChat: async (chatId, patch) => updates.push({ chatId, patch }) };
}

async function raiseChatApproval(svc, chatId, { expiresAt } = {}) {
  return svc.raise({
    runId: 'chat-00000000-0000-4000-8000-000000000001',
    kind: 'approval',
    origin: 'tool',
    prompt: {
      message: 'Run dangerous?',
      inputType: 'confirm',
      displayData: { toolId: 'dangerous', args: { target: 'ACME-12' } }
    },
    policy: expiresAt ? { expiresAt } : { timeoutMs: 60_000 },
    source: { chatId, toolCallId: 'call_1', toolId: 'dangerous' }
  });
}

const storedChat = interaction => ({
  toolApproval: {
    grants: [],
    pending: {
      interactionId: interaction.id,
      call: { id: 'call_1', name: 'dangerous', toolId: 'dangerous', args: { target: 'X' } },
      transcript: pausedTranscript({ target: 'ACME-12' })
    }
  }
});

const allow = async () => true;

test('settle: approve with "allow for this chat" answers once, records the grant and hands over the approved args', async t => {
  const svc = await interactionsFor(t);
  const chatId = 'chat-settle-approve';
  const interaction = await raiseChatApproval(svc, chatId);
  const repository = fakeRepository();
  const result = await settleChatApprovals({
    chatId,
    user: { id: 'u1' },
    chat: storedChat(interaction),
    lastMessage: {
      role: 'user',
      approvalResponse: { interactionId: interaction.id, decision: 'approve', grant: 'chat' }
    },
    repository,
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.equal(result.refusal, null);
  assert.equal(result.resume.outcome, 'approved');
  assert.deepEqual(result.resume.args, { target: 'ACME-12' }, 'the args the person saw');
  assert.deepEqual(result.grants, ['dangerous']);
  assert.deepEqual(repository.updates.at(-1).patch, {
    toolApproval: { grants: ['dangerous'], pending: null }
  });
  assert.equal((await svc.get(interaction.id)).status, 'answered');
});

test('settle: a double answer is refused and cannot run the call twice', async t => {
  const svc = await interactionsFor(t);
  const chatId = 'chat-settle-double';
  const interaction = await raiseChatApproval(svc, chatId);
  const chat = storedChat(interaction);
  const params = () => ({
    chatId,
    user: { id: 'u1' },
    chat,
    lastMessage: { approvalResponse: { interactionId: interaction.id, decision: 'approve' } },
    repository: fakeRepository(),
    interactionService: svc,
    authorizeInteraction: allow
  });
  const results = await Promise.all([settleChatApprovals(params()), settleChatApprovals(params())]);
  const resumed = results.filter(r => r.resume);
  const refused = results.filter(r => r.refusal);
  assert.equal(resumed.length, 1, 'exactly one continuation');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].refusal.code, 'APPROVAL_ALREADY_ANSWERED');
  // A later retry of the same answer is refused too.
  const again = await settleChatApprovals(params());
  assert.equal(again.refusal.code, 'APPROVAL_ALREADY_ANSWERED');
});

test('settle: reject, expiry and an unknown approval', async t => {
  const svc = await interactionsFor(t);
  const rejectChat = 'chat-settle-reject';
  const rejected = await raiseChatApproval(svc, rejectChat);
  const r1 = await settleChatApprovals({
    chatId: rejectChat,
    user: { id: 'u1' },
    chat: storedChat(rejected),
    lastMessage: { approvalResponse: { interactionId: rejected.id, decision: 'reject' } },
    repository: fakeRepository(),
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.equal(r1.resume.outcome, 'rejected');
  assert.deepEqual(r1.grants, []);

  const expiredChat = 'chat-settle-expired';
  const expired = await raiseChatApproval(svc, expiredChat, {
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  const r2 = await settleChatApprovals({
    chatId: expiredChat,
    user: { id: 'u1' },
    chat: storedChat(expired),
    lastMessage: { approvalResponse: { interactionId: expired.id, decision: 'approve' } },
    repository: fakeRepository(),
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.equal(r2.resume.outcome, 'expired');

  const r3 = await settleChatApprovals({
    chatId: 'chat-settle-none',
    user: { id: 'u1' },
    chat: null,
    lastMessage: { approvalResponse: { interactionId: 'nope', decision: 'approve' } },
    repository: fakeRepository(),
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.equal(r3.refusal.code, 'APPROVAL_NOT_PENDING');

  const r4 = await settleChatApprovals({
    chatId: 'chat-settle-bad',
    user: { id: 'u1' },
    chat: null,
    lastMessage: { approvalResponse: { interactionId: 'x', decision: 'maybe' } },
    repository: fakeRepository(),
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.equal(r4.refusal.code, 'INVALID_APPROVAL_RESPONSE');
});

test('settle: any other message supersedes a pending approval and drops the stored transcript', async t => {
  const svc = await interactionsFor(t);
  const chatId = 'chat-settle-supersede';
  const interaction = await raiseChatApproval(svc, chatId);
  const repository = fakeRepository();
  const result = await settleChatApprovals({
    chatId,
    user: { id: 'u1' },
    chat: storedChat(interaction),
    lastMessage: { role: 'user', content: 'Never mind, something else.' },
    repository,
    interactionService: svc,
    authorizeInteraction: allow
  });
  assert.equal(result.resume, null);
  assert.equal((await svc.get(interaction.id)).status, 'cancelled');
  assert.deepEqual(repository.updates.at(-1).patch, {
    toolApproval: { grants: [], pending: null }
  });
});

test('the paused transcript is the turn after its question, bounded, and stays on the server', () => {
  const question = { role: 'user', content: 'Q' };
  const big = 'x'.repeat(40 * 1024);
  const messages = [
    { role: 'system', content: 'S' },
    question,
    { role: 'assistant', content: null, tool_calls: [{ id: 'c0', function: { name: 'search' } }] },
    { role: 'tool', tool_call_id: 'c0', content: big, imageData: { base64: 'AAAA' } },
    ...pausedTranscript({ target: 'A' })
  ];
  const transcript = pausedTurnTranscript(messages, {
    startMessage: question,
    toolCallId: 'call_1'
  });
  assert.equal(transcript.length, 4);
  assert.equal(transcript[0].tool_calls[0].id, 'c0');
  assert.ok(transcript[1].content.length < big.length, 'long results are cut');
  assert.equal(transcript[1].imageData, undefined, 'pictures are dropped');
  assert.equal(pausedTurnTranscript(messages, { toolCallId: 'missing' }), null);

  const prompt = continuationMessages(
    [{ role: 'system', content: 'S' }, question, { role: 'user', content: 'Approved: x' }],
    transcript
  );
  assert.equal(prompt.length, 2 + transcript.length);
  assert.equal(prompt[1], question);

  const view = publicChatView({
    id: 'c',
    toolApproval: {
      grants: ['dangerous'],
      pending: { interactionId: 'i', call: { id: 'call_1', name: 'dangerous' }, transcript }
    }
  });
  assert.equal(view.toolApproval.pending.transcript, undefined);
  assert.deepEqual(view.toolApproval.grants, ['dangerous']);
});

test('an app without chat history gets the paused question back before the transcript', () => {
  const transcript = pausedTranscript({ target: 'A' });
  const prompt = continuationMessages(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Approved: dangerous' }
    ],
    transcript,
    { question: 'Please change ACME-12' }
  );
  assert.deepEqual(
    prompt.map(m => m.role),
    ['system', 'user', 'assistant', 'tool']
  );
  assert.equal(prompt[1].content, 'Please change ACME-12');
  // With the history in the prompt, nothing is added.
  const withHistory = continuationMessages(
    [
      { role: 'user', content: 'Please change ACME-12' },
      { role: 'user', content: 'Approved: dangerous' }
    ],
    transcript,
    { question: 'Please change ACME-12' }
  );
  assert.equal(withHistory.filter(m => m.role === 'user').length, 1);
});
