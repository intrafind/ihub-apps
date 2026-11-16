// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One answer is one run, also across a pause: a chat turn that pauses for a
 * tool approval or a clarification is continued under the same run id once
 * the person answers (`RunLog.continueRun`), so its journal — and the
 * evidence record built from it — holds the whole turn. The continuation
 * works from another worker and after a restart; a run that cannot be
 * continued (another model, journal gone, not paused) leaves the turn to a
 * run of its own, as before.
 *
 * Through `ChatService.runTurn` on the real `AgentLoop`, `LLMClient` and
 * `RunLog` over a filesystem provider, with a scripted model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ChatService from '../../services/chat/ChatService.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import { projectLedgerEvent } from '../../services/loop/RunStream.js';
import { prepareChatApproval } from '../../services/chat/chatToolApproval.js';
import { registerChatClarificationLifecycle } from '../../services/chat/chatClarificationLifecycle.js';
import { buildEvidence } from '../../services/chat/evidenceRecord.js';
import { getRunSummaryRepository } from '../../services/runtime/RunSummaryRepository.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { startTestStorage } from '../helpers/testStorage.js';
import { makeClient, sseResponse, MODELS } from './helpers/llmFixtures.js';
import { RUN_LOG_EVENTS, SSE_V2_EVENTS } from '../../../shared/runEvents.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const user = { id: 'u1', groups: ['users'] };

function textTurn(content) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

function toolTurn(name, args, id = 'call_1') {
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

/** Workers sharing one ownership table and one set of responders, like the real bus. */
function fakeCluster() {
  const owners = new Map();
  const responders = new Map();
  return {
    worker(id) {
      return {
        createPresenceMap(kind) {
          class PresenceMap extends Map {
            set(key, value) {
              owners.set(`${kind}:${key}`, id);
              return super.set(key, value);
            }
            delete(key) {
              if (owners.get(`${kind}:${key}`) === id) owners.delete(`${kind}:${key}`);
              return super.delete(key);
            }
            clear() {
              for (const key of [...this.keys()]) this.delete(key);
            }
          }
          return new PresenceMap();
        },
        hasRemote(kind, key) {
          const owner = owners.get(`${kind}:${key}`);
          return owner !== undefined && owner !== id;
        },
        respond(type, handler) {
          if (!responders.has(type)) responders.set(type, new Map());
          responders.get(type).set(id, handler);
          return () => responders.get(type)?.delete(id);
        },
        async request(type, payload, { route } = {}) {
          const target = route ? owners.get(`${route.kind}:${route.key}`) : undefined;
          const handler =
            target === undefined || target === id ? null : responders.get(type)?.get(target);
          if (!handler) return null;
          const reply = await handler(payload);
          return reply === undefined ? null : reply;
        }
      };
    }
  };
}

/** Storage, a cluster of run logs, one interaction service and a chat store. */
async function setup(t) {
  const storage = await startTestStorage({ prefix: 'chat-run-continuation-' });
  const cluster = fakeCluster();
  const logs = [];
  const worker = id => {
    const log = new RunLog({
      forceEnabled: true,
      getPlatformConfig: () => ({}),
      bus: cluster.worker(id)
    });
    logs.push(log);
    return log;
  };
  const first = worker(1);
  const interactionService = new InteractionService({ runLog: first });
  const unregister = registerChatClarificationLifecycle(interactionService, { runLog: first });
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-run-continuation-chats-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: silentLogger
  });
  t.after(async () => {
    unregister();
    await interactionService.stop?.();
    for (const log of logs) await log.stop();
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await storage.stop();
  });
  return { runLog: first, worker, interactionService, repository };
}

/** A chat service whose loop, client and ledger all write to `runLog`. */
function serviceOn(runLog, interactionService, turns) {
  const script = [...turns];
  const { client } = makeClient({
    maxRetries: 0,
    runLog,
    transport: async () => {
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      return sseResponse(next);
    }
  });
  return new ChatService({
    agentLoop: new AgentLoop({ llmClient: client, runLog, logger: silentLogger }),
    runLog,
    interactionService,
    logInteraction: async () => {},
    runTool: async toolId => ({ ok: true, toolId, rows: 3 }),
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
}

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
const ASK_USER = {
  id: 'ask_user',
  name: 'ask_user',
  description: 'ask the user',
  parameters: { type: 'object', properties: { question: { type: 'string' } } }
};

function turn(service, { chatId, repository, content, model = MODELS.openai, tools, ...rest }) {
  return service.runTurn({
    prep: {
      app: { id: 'app1' },
      model,
      llmMessages: [{ role: 'user', content }],
      tools,
      maxTokens: 256,
      llmOptions: {}
    },
    chatId,
    streaming: false,
    headless: false,
    canApproveTools: true,
    buildLogData: () => ({}),
    language: 'en',
    user,
    getLocalizedError: async () => null,
    persistence: { repository, ownerId: 'u1', identityMode: 'default', content },
    ...rest
  });
}

const newChatId = label => `chat-cont-${label}-${crypto.randomUUID().slice(0, 8)}`;

/** Pause a turn on an approval of `dangerous`; returns the run id and the approval to answer. */
async function pauseOnApproval(service, { chatId, repository }) {
  const paused = await turn(service, {
    chatId,
    repository,
    content: 'Please change ACME-12',
    tools: [GATED]
  });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.finishReason, 'approval');
  return paused;
}

/** Answer the chat's pending approval the way the chat route does. */
async function approve({ chatId, repository, interactionService, interactionId }) {
  const prepared = await prepareChatApproval({
    chatId,
    user,
    chat: await repository.getChat(chatId),
    lastMessage: { approvalResponse: { interactionId, decision: 'approve' } },
    repository,
    interactionService,
    authorizeInteraction: async () => true
  });
  assert.equal(prepared.refusal, null);
  const committed = await prepared.commit();
  assert.equal(committed.refusal, null);
  return { pausedTurn: prepared.pausedTurn, toolApproval: committed };
}

const typesOf = events => events.map(e => e.type);

test('an approval: the continuation keeps the run id; one journal and one evidence record cover the turn', async t => {
  const { runLog, interactionService, repository } = await setup(t);
  const chatId = newChatId('approval');
  const service = serviceOn(runLog, interactionService, [
    toolTurn('dangerous', { target: 'ACME-12' }),
    textTurn('The ticket was updated.')
  ]);
  const paused = await pauseOnApproval(service, { chatId, repository });
  const { pausedTurn, toolApproval } = await approve({
    chatId,
    repository,
    interactionService,
    interactionId: paused.pendingInteraction.id
  });
  assert.deepEqual(pausedTurn, {
    runId: paused.runId,
    interactionId: paused.pendingInteraction.id
  });

  const answer = await turn(service, {
    chatId,
    repository,
    content: 'Approved: dangerous',
    tools: [GATED],
    runId: pausedTurn.runId,
    continueRun: { interactionId: pausedTurn.interactionId },
    toolApproval
  });
  assert.equal(answer.status, 'completed');
  assert.equal(answer.runId, paused.runId, 'one answer, one run');

  await runLog.flush();
  const events = await runLog.readEvents(paused.runId);
  const types = typesOf(events);
  assert.equal(types.filter(type => type === RUN_LOG_EVENTS.RUN_START).length, 1);
  assert.deepEqual(
    events.filter(e => e.type === RUN_LOG_EVENTS.RUN_END).map(e => e.data.status),
    ['paused', 'completed']
  );
  const pausedAt = types.indexOf(RUN_LOG_EVENTS.RUN_END);
  const resumedAt = types.indexOf(RUN_LOG_EVENTS.RUN_RESUMED);
  assert.ok(pausedAt < types.indexOf(RUN_LOG_EVENTS.INTERACTION_ANSWERED));
  assert.ok(types.indexOf(RUN_LOG_EVENTS.INTERACTION_ANSWERED) < resumedAt);
  assert.equal(events[resumedAt].data.interactionId, paused.pendingInteraction.id);
  assert.equal(types.at(-1), RUN_LOG_EVENTS.RUN_END);
  // Before the pause: the call that asked for the tool; after it: the approved call and the answer.
  assert.equal(types.slice(0, pausedAt).filter(type => type === 'request/header').length, 1);
  assert.equal(types.slice(resumedAt).filter(type => type === 'request/header').length, 1);
  assert.ok(types.slice(resumedAt).includes(RUN_LOG_EVENTS.TOOL_CALL));
  assert.deepEqual(
    events.map(e => e.seq),
    events.map((_, index) => index + 1),
    'one sequence across the pause'
  );

  const summary = await getRunSummaryRepository().get(paused.runId);
  assert.equal(summary.status, 'completed');
  assert.ok(summary.endedAt);

  const built = await buildEvidence({ runLog, runId: paused.runId, summary: answer });
  assert.equal(built.record.runId, paused.runId);
  assert.equal(built.record.calls.length, 2, 'the call before the pause and the one after it');
  assert.equal(built.record.journalEnded, true);
  assert.ok(built.record.toolCalls.some(call => call.callId === 'call_1' && call.result));

  // A ledger replay shows the pause as a pause and the continuation after it.
  const frames = events.flatMap(projectLedgerEvent).map(f => f.type);
  assert.deepEqual(
    frames.filter(type => type.startsWith('run/')),
    [
      SSE_V2_EVENTS.RUN_STARTED,
      SSE_V2_EVENTS.RUN_PAUSED,
      SSE_V2_EVENTS.RUN_RESUMED,
      SSE_V2_EVENTS.RUN_ENDED
    ]
  );
});

test('a clarification: the answer continues the run that asked', async t => {
  const { runLog, interactionService, repository } = await setup(t);
  const chatId = newChatId('clarify');
  const service = serviceOn(runLog, interactionService, [
    toolTurn('ask_user', { question: 'Which year?' }),
    textTurn('Here is 2025.')
  ]);
  const paused = await turn(service, {
    chatId,
    repository,
    content: 'Show me the report',
    tools: [ASK_USER],
    streaming: true
  });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.finishReason, 'clarification');
  await interactionService.answer(
    paused.pendingInteraction.id,
    { value: '2025' },
    {
      user,
      channel: 'chat'
    }
  );

  const answer = await turn(service, {
    chatId,
    repository,
    content: '2025',
    tools: [ASK_USER],
    runId: paused.runId,
    continueRun: { interactionId: paused.pendingInteraction.id }
  });
  assert.equal(answer.runId, paused.runId);
  assert.equal(answer.status, 'completed');

  await runLog.flush();
  const events = await runLog.readEvents(paused.runId);
  assert.deepEqual(
    events.filter(e => e.type === RUN_LOG_EVENTS.RUN_END).map(e => e.data.status),
    ['paused', 'completed'],
    'the chat-channel answer did not close the run behind the continuation'
  );
  const built = await buildEvidence({ runLog, runId: paused.runId, summary: answer });
  assert.equal(built.record.calls.length, 2);
  assert.ok(built.record.toolCalls.some(call => call.toolId === 'ask_user'));
});

test('a quick answer waits for the paused turn to finish its wrap-up before continuing', async t => {
  const { runLog, interactionService, repository } = await setup(t);
  const chatId = newChatId('race');
  const order = [];
  // The paused turn's wrap-up is slow: the card is out before the chat is released.
  const releaseRun = repository.releaseRun.bind(repository);
  let slow = true;
  repository.releaseRun = async (...args) => {
    if (slow) {
      slow = false;
      await new Promise(resolve => setTimeout(resolve, 300));
      const result = await releaseRun(...args);
      order.push('paused turn released the chat');
      return result;
    }
    return releaseRun(...args);
  };
  const service = serviceOn(runLog, interactionService, [
    toolTurn('dangerous', { target: 'ACME-12' }),
    textTurn('The ticket was updated.')
  ]);
  const pausing = turn(service, {
    chatId,
    repository,
    content: 'Please change ACME-12',
    tools: [GATED]
  });
  // Answer as soon as the approval can be answered.
  let pending = null;
  while (!pending) {
    await new Promise(resolve => setTimeout(resolve, 5));
    pending = (await repository.getChat(chatId))?.toolApproval?.pending || null;
  }
  const { pausedTurn, toolApproval } = await approve({
    chatId,
    repository,
    interactionService,
    interactionId: pending.interactionId
  });
  const unsubscribe = runLog.subscribe(pending.runId, event => {
    if (event.type === RUN_LOG_EVENTS.RUN_RESUMED) order.push('continuation resumed the run');
  });
  t.after(unsubscribe);
  const answer = await turn(service, {
    chatId,
    repository,
    content: 'Approved: dangerous',
    tools: [GATED],
    runId: pausedTurn.runId,
    continueRun: { interactionId: pausedTurn.interactionId },
    toolApproval
  });
  const paused = await pausing;
  assert.equal(paused.status, 'paused');
  assert.equal(answer.runId, paused.runId);
  assert.deepEqual(order, ['paused turn released the chat', 'continuation resumed the run']);
  const chat = await repository.getChat(chatId);
  assert.equal(chat.activeRunId, null, 'released by the continuation, after its answer');
  const { messages } = await repository.getMessages(chatId);
  assert.deepEqual(
    messages.map(m => m.role),
    ['user', 'user', 'assistant'],
    'the answer follows the continuation question'
  );
});

test('a run still held by its turn beyond the wait is not continued', async t => {
  const { runLog } = await setup(t);
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  runLog.endRun(runId, { status: 'paused', finishReason: 'approval' });
  const release = runLog.hold(runId);
  t.after(release);
  assert.equal(await runLog.continueRun(runId), null);
  release();
  assert.ok(await runLog.continueRun(runId), 'continued once the wrap-up is done');
});

test('a paused run whose journal was deleted anyway is not continued', async t => {
  const { runLog } = await setup(t);
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  runLog.endRun(runId, { status: 'paused', finishReason: 'approval' });
  await runLog.flush();
  await runLog._store.deleteJournal(runId);
  assert.equal(await runLog.isJournalDeleted(runId), true);
  assert.equal(await runLog.continueRun(runId), null, 'the turn gets a run of its own');
  assert.deepEqual(await runLog.readEvents(runId), [], 'nothing re-created');
});

test('after a restart the continuation recovers the sequence from the journal', async t => {
  const { runLog, worker, interactionService, repository } = await setup(t);
  const chatId = newChatId('restart');
  const paused = await pauseOnApproval(
    serviceOn(runLog, interactionService, [toolTurn('dangerous', { target: 'ACME-12' })]),
    { chatId, repository }
  );
  const { pausedTurn, toolApproval } = await approve({
    chatId,
    repository,
    interactionService,
    interactionId: paused.pendingInteraction.id
  });
  await runLog.stop(); // the process that paused the run is gone

  const restarted = worker(2);
  const answer = await turn(serviceOn(restarted, interactionService, [textTurn('Done.')]), {
    chatId,
    repository,
    content: 'Approved: dangerous',
    tools: [GATED],
    runId: pausedTurn.runId,
    continueRun: { interactionId: pausedTurn.interactionId },
    toolApproval
  });
  assert.equal(answer.runId, paused.runId);
  await restarted.flush();
  const events = await restarted.readEvents(paused.runId);
  assert.deepEqual(
    events.map(e => e.seq),
    events.map((_, index) => index + 1)
  );
  const built = await buildEvidence({ runLog: restarted, runId: paused.runId, summary: answer });
  assert.equal(built.record.calls.length, 2);
});

test('on another worker: the worker that paused the run hands its sequence over', async t => {
  const { runLog: pausing, worker } = await setup(t);
  const other = worker(2);
  const { runId } = await pausing.startRun({
    kind: 'chat',
    user: { id: 'u1' },
    refs: { chatId: 'c1', appId: 'app1' },
    model: 'oa'
  });
  pausing.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'hi' });
  pausing.endRun(runId, { status: 'paused', finishReason: 'approval' });
  assert.equal(pausing.getRunMeta(runId).owned, true, 'still within the grace window');

  const continued = await other.continueRun(runId, { interactionId: 'i1' });
  assert.ok(continued);
  assert.equal(continued.paused.data.status, 'paused');
  assert.equal(pausing.getRunMeta(runId), null, 'the pausing worker let go');
  assert.equal(other.getRunMeta(runId).owned, true);
  other.append(runId, RUN_LOG_EVENTS.MESSAGE_USER, { step: 0, content: 'go' });
  other.endRun(runId, { status: 'completed' });
  await other.flush();
  const events = await other.readEvents(runId);
  assert.deepEqual(
    events.map(e => e.seq),
    [1, 2, 3, 4, 5, 6]
  );
  assert.equal(events[3].type, RUN_LOG_EVENTS.RUN_RESUMED);

  // A run that is producing on its worker is not handed over.
  const { runId: running } = await pausing.startRun({ kind: 'chat', user: { id: 'u1' } });
  assert.equal(await other.continueRun(running), null);
});

test('fallbacks: another model, a journal that is gone, a run that is not paused → a run of its own', async t => {
  const { runLog, interactionService, repository } = await setup(t);

  // Another model than the paused turn's.
  const chatId = newChatId('model');
  const paused = await pauseOnApproval(
    serviceOn(runLog, interactionService, [toolTurn('dangerous', { target: 'ACME-12' })]),
    { chatId, repository }
  );
  const { pausedTurn, toolApproval } = await approve({
    chatId,
    repository,
    interactionService,
    interactionId: paused.pendingInteraction.id
  });
  const answer = await turn(serviceOn(runLog, interactionService, [textTurn('Done.')]), {
    chatId,
    repository,
    content: 'Approved: dangerous',
    tools: [GATED],
    model: MODELS.local,
    runId: pausedTurn.runId,
    continueRun: { interactionId: pausedTurn.interactionId },
    toolApproval
  });
  assert.equal(answer.status, 'completed');
  assert.notEqual(answer.runId, paused.runId);
  await runLog.flush();
  const old = await runLog.readEvents(paused.runId);
  assert.equal(old.filter(e => e.type === RUN_LOG_EVENTS.RUN_RESUMED).length, 0);
  assert.equal((await getRunSummaryRepository().get(paused.runId)).status, 'paused');
  assert.equal((await runLog.readEvents(answer.runId))[0].type, RUN_LOG_EVENTS.RUN_START);

  // A run that ended (or was continued already) is not paused.
  assert.equal(await runLog.continueRun(answer.runId), null);
  assert.equal(await runLog.continueRun(paused.runId, { accept: () => false }), null);

  // A journal that is gone.
  await runLog.deleteRun(paused.runId);
  assert.equal(await runLog.continueRun(paused.runId), null);
});
