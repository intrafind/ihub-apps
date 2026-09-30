/**
 * What a chat turn did — searches, documents, tool calls, workflow steps — is
 * stored with its answer, so a user who comes back to the chat can see it.
 *
 * Covers the recorder that folds a run's SSE v2 frames on the server
 * (`services/chat/runActivity.js`), the bounds the stored form keeps, what a
 * share carries of it, the materializer writing it, its rebuild from the
 * ledger, and the recovery of a chat whose run died with its process
 * (`services/chat/chatRecovery.js`).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import {
  materializeAssistantTurn,
  materializeUserTurn
} from '../services/chat/chatMaterializer.js';
import {
  MAX_STORED_TOOL_ITEMS,
  _resetRunActivity,
  boundStoredActivity,
  isRecordingRunActivity,
  rebuildRunActivity,
  recordRunActivity,
  shareableActivity,
  takeRunActivity
} from '../services/chat/runActivity.js';
import {
  INTERRUPTED_RUN_GRACE_MS,
  RUN_INTERRUPTED,
  isChatRunAlive,
  settleInterruptedChat
} from '../services/chat/chatRecovery.js';
import { snapshotMessage } from '../services/chat/ChatShareRepository.js';
import { mentionAccess } from '../services/workflow/workflowAccess.js';
import { RunStreamEmitter } from '../services/loop/RunStream.js';
import { RUN_LOG_EVENTS, SSE_V2_EVENTS } from '../../shared/runEvents.js';

const CHAT_ID = 'chat-activity';
const RUN_ID = 'chat-run-activity';

afterEach(() => _resetRunActivity());

/** An emitter on the chat stream that delivers nowhere — the tap sees it anyway. */
function emitter(runId = RUN_ID) {
  return new RunStreamEmitter({ streamId: CHAT_ID, runId, deliver: () => {} });
}

function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-activity-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: quietLogger()
  });
  try {
    await fn(repository);
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/** A chat turn that searched the web, read iFinder and answered from both. */
function emitSearchingTurn(stream) {
  stream.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'chat', refs: { chatId: CHAT_ID } });
  stream.emit(SSE_V2_EVENTS.TOOL_STARTED, {
    step: 0,
    callId: 'call-web',
    toolId: 'braveSearch',
    name: 'braveSearch',
    args: { query: 'wind power 2026', count: 5 }
  });
  stream.emit(SSE_V2_EVENTS.TOOL_COMPLETED, {
    step: 0,
    callId: 'call-web',
    toolId: 'braveSearch',
    name: 'braveSearch',
    resultPreview: 'a very long preview',
    durationMs: 420,
    knowledgeSource: 'websearch',
    webSources: [{ url: 'https://example.org/wind', title: 'Wind' }]
  });
  stream.emit(SSE_V2_EVENTS.TOOL_STARTED, {
    step: 0,
    callId: 'call-docs',
    toolId: 'iFinder_search',
    name: 'iFinder_search',
    args: { query: 'Windpark Stellungnahme' }
  });
  stream.emit(SSE_V2_EVENTS.TOOL_COMPLETED, {
    step: 0,
    callId: 'call-docs',
    toolId: 'iFinder_search',
    name: 'iFinder_search',
    resultPreview: null,
    knowledgeSource: 'ifinder',
    webSources: [{ documentId: 'doc-7', title: 'Internal memo', url: 'https://ifinder/doc-7' }]
  });
  // iAssistant reports its own searches as status events.
  stream.emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
    step: 0,
    phase: 'search.status',
    data: { event: 'search.started', queries: ['Windpark'] }
  });
  stream.emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
    step: 0,
    phase: 'search.status',
    data: { event: 'search.finished', numberOfHits: 12, sources: ['Intranet'] }
  });
  // Live-only: the page being read right now, and the answer text.
  stream.emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
    step: 0,
    phase: 'fetch.started',
    data: { url: 'https://example.org/wind' }
  });
  stream.emit(SSE_V2_EVENTS.STEP_DELTA, { step: 1, kind: 'text', content: 'The answer.' });
  stream.emit(SSE_V2_EVENTS.RUN_ENDED, { status: 'completed', finishReason: 'stop' });
}

describe('recording what a turn did', () => {
  it('folds the frames of a recorded run into the activity the chat shows', () => {
    recordRunActivity(RUN_ID);
    emitSearchingTurn(emitter());

    const activity = takeRunActivity(RUN_ID);
    const [web, docs] = activity.toolActivity.items;
    assert.equal(web.kind, 'search');
    assert.equal(web.scope, 'web');
    assert.equal(web.query, 'wind power 2026');
    assert.equal(web.status, 'completed');
    assert.equal(web.durationMs, 420);
    assert.deepEqual(web.sources, [{ url: 'https://example.org/wind', title: 'Wind' }]);
    // The arguments the row does not show are listed as details.
    assert.deepEqual(web.details, [{ name: 'count', values: [{ text: '5' }], more: 0 }]);
    assert.equal(docs.scope, 'documents');
    assert.equal(activity.toolActivity.reading, null);

    assert.equal(activity.searchSummary.totalHits, 12);
    assert.deepEqual(activity.searchSummary.queries, ['Windpark']);
    assert.equal(activity.searchSummary.searching, false);
    assert.deepEqual(activity.answerSource, {
      sources: ['websearch', 'ifinder'],
      type: 'mixed'
    });
    assert.equal(isRecordingRunActivity(RUN_ID), false, 'taking the activity ends the recording');
  });

  it('records nothing for a run nobody asked to record', () => {
    emitSearchingTurn(emitter());
    assert.equal(takeRunActivity(RUN_ID), null);
  });

  it('returns nothing for a plain answer', () => {
    recordRunActivity(RUN_ID);
    const stream = emitter();
    stream.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'chat', refs: {} });
    stream.emit(SSE_V2_EVENTS.STEP_DELTA, { step: 0, kind: 'text', content: 'hello' });
    stream.emit(SSE_V2_EVENTS.RUN_ENDED, { status: 'completed', finishReason: 'stop' });
    assert.equal(takeRunActivity(RUN_ID), null);
  });

  it('keeps the steps and the result of an @mention workflow run', () => {
    const runId = 'workflow-mention';
    recordRunActivity(runId);
    const stream = emitter(runId);
    stream.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'workflow', refs: { chatId: CHAT_ID } });
    const node = (nodeName, status) =>
      stream.emit(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: runId,
        nodeId: nodeName,
        nodeName,
        nodeType: 'prompt',
        status,
        progress: { workflowName: 'Review', chatVisible: true }
      });
    node('Document 1/2', 'running');
    node('Document 2/2', 'running');
    // A reconnecting client is sent the steps again; that is not a new step.
    stream.emit(SSE_V2_EVENTS.PROGRESS_NODE, {
      executionId: runId,
      nodeId: 'replay-1',
      nodeName: 'Document 2/2',
      status: 'running',
      progress: { workflowName: 'Review', replay: true }
    });
    stream.emit(SSE_V2_EVENTS.META, {
      executionId: runId,
      extra: { workflow: { status: 'completed', workflowName: 'Review', outputFormat: 'markdown' } }
    });
    stream.emit(SSE_V2_EVENTS.RUN_ENDED, { status: 'completed', finishReason: 'stop' });

    const activity = takeRunActivity(runId);
    assert.deepEqual(
      activity.workflowSteps.map(s => [s.nodeName, s.status]),
      [
        ['Document 1/2', 'completed'],
        ['Document 2/2', 'completed']
      ]
    );
    assert.deepEqual(activity.workflowResult, {
      status: 'completed',
      executionId: runId,
      workflowName: 'Review'
    });
    assert.equal(activity.outputFormat, 'markdown');
  });

  it('includes the workflow a tool started inside the turn', () => {
    recordRunActivity(RUN_ID);
    const chat = emitter();
    chat.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'chat', refs: {} });
    const child = emitter('workflow-child');
    child.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'workflow', parentRunId: RUN_ID, refs: {} });
    child.emit(SSE_V2_EVENTS.PROGRESS_NODE, {
      executionId: 'workflow-child',
      nodeId: 'n1',
      nodeName: 'Extract',
      status: 'running',
      progress: { workflowName: 'Child' }
    });
    child.emit(SSE_V2_EVENTS.META, {
      executionId: 'workflow-child',
      extra: { workflow: { status: 'failed', workflowName: 'Child' } }
    });
    chat.emit(SSE_V2_EVENTS.RUN_ENDED, { status: 'completed', finishReason: 'stop' });

    const activity = takeRunActivity(RUN_ID);
    assert.deepEqual(activity.workflowSteps, [
      {
        nodeName: 'Extract',
        nodeType: undefined,
        status: 'error',
        workflowName: 'Child',
        chatVisible: undefined
      }
    ]);
    assert.equal(activity.workflowResult.status, 'failed');
  });

  it('marks a call the run never saw finish as stopped', () => {
    recordRunActivity(RUN_ID);
    const stream = emitter();
    stream.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'chat', refs: {} });
    stream.emit(SSE_V2_EVENTS.TOOL_STARTED, {
      step: 0,
      callId: 'c1',
      toolId: 'webContentExtractor',
      name: 'webContentExtractor',
      args: { url: 'https://example.org' }
    });
    // No run/ended: the run was superseded or failed around the call.
    const activity = takeRunActivity(RUN_ID);
    assert.equal(activity.toolActivity.items[0].status, 'stopped');
  });
});

describe('the stored form of the activity', () => {
  it('bounds lists and strings and keeps only known fields', () => {
    const long = 'x'.repeat(5000);
    const items = Array.from({ length: MAX_STORED_TOOL_ITEMS + 20 }, (_, i) => ({
      id: `c${i}`,
      kind: 'search',
      toolId: 'braveSearch',
      name: 'braveSearch',
      status: 'completed',
      scope: 'web',
      query: long,
      details: [{ name: 'filter', values: [{ text: 'short', full: long }], more: 0 }],
      sources: [{ url: 'https://a', title: 't', unexpected: 'dropped' }],
      error: null,
      durationMs: 3,
      injected: { anything: true }
    }));
    const stored = boundStoredActivity({ toolActivity: { items, reading: 'x' }, rogue: 1 });

    assert.equal(stored.toolActivity.items.length, MAX_STORED_TOOL_ITEMS);
    assert.equal(stored.toolActivity.reading, null);
    assert.equal(stored.rogue, undefined);
    const [first] = stored.toolActivity.items;
    assert.equal(first.injected, undefined);
    assert.ok(first.query.length <= 2001);
    assert.deepEqual(first.sources, [{ url: 'https://a', title: 't' }]);
    // A hundred calls with long arguments are past the size bound: the full
    // text of the arguments goes first, the calls themselves stay.
    assert.equal(first.details[0].values[0].full, undefined);
    assert.equal(first.details[0].values[0].text, 'short');
    assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 256 * 1024);
  });

  it('cuts the full text of a long argument to the string bound', () => {
    const long = 'y'.repeat(5000);
    const stored = boundStoredActivity({
      toolActivity: {
        items: [
          {
            id: 'c',
            kind: 'tool',
            toolId: 'x',
            name: 'x',
            status: 'completed',
            details: [{ name: 'text', values: [{ text: 'y…', full: long }], more: 0 }],
            sources: []
          }
        ]
      }
    });
    const value = stored.toolActivity.items[0].details[0].values[0];
    assert.equal(value.full.length, 2001);
    assert.ok(value.full.endsWith('…'));
  });

  it('keeps the end of a long workflow', () => {
    const steps = Array.from({ length: 250 }, (_, i) => ({
      nodeName: `Step ${i}`,
      status: 'completed'
    }));
    const stored = boundStoredActivity({ workflowSteps: steps });
    assert.equal(stored.workflowSteps.length, 200);
    assert.equal(stored.workflowSteps.at(-1).nodeName, 'Step 249');
  });

  it('is nothing when there is nothing', () => {
    assert.equal(boundStoredActivity(null), null);
    assert.equal(boundStoredActivity({}), null);
  });
});

describe('what a share carries of the activity', () => {
  const activity = {
    toolActivity: {
      items: [
        {
          id: 'w',
          kind: 'search',
          scope: 'web',
          query: 'public',
          sources: [{ url: 'https://example.org' }]
        },
        {
          id: 'd',
          kind: 'search',
          scope: 'documents',
          query: 'Windpark',
          sources: [{ documentId: 'doc-7', title: 'Internal memo' }]
        },
        {
          id: 'r',
          kind: 'fetch',
          scope: 'documents',
          documentId: 'doc-7',
          title: 'Internal memo',
          url: 'https://ifinder/doc-7',
          sources: []
        }
      ],
      reading: null
    },
    searchSummary: { queries: ['Windpark'], totalHits: 12, applications: ['HR'], sources: ['x'] }
  };

  it('drops what the owner’s document searches found, and keeps what the turn did', () => {
    const shared = shareableActivity(activity);
    const [web, docs, read] = shared.toolActivity.items;
    assert.deepEqual(web.sources, [{ url: 'https://example.org' }]);
    assert.equal(docs.query, 'Windpark');
    assert.deepEqual(docs.sources, []);
    assert.equal(read.title, undefined);
    assert.equal(read.url, undefined);
    assert.equal(read.documentId, undefined);
    assert.equal(shared.searchSummary.totalHits, 12);
    assert.deepEqual(shared.searchSummary.applications, []);
    assert.deepEqual(shared.searchSummary.sources, []);
  });

  it('is applied to the snapshot of a shared message', () => {
    const snapshot = snapshotMessage({ id: 'm', role: 'assistant', content: 'a', activity });
    assert.deepEqual(snapshot.activity.toolActivity.items[1].sources, []);
    assert.equal(activity.toolActivity.items[1].sources.length, 1, 'the stored one is untouched');
  });
});

describe('the materializer stores the activity with the answer', () => {
  it('writes what the run recorded', async () => {
    await withRepository(async repository => {
      await materializeUserTurn({
        repository,
        chatId: CHAT_ID,
        ownerId: 'user-1',
        identityMode: 'default',
        appId: 'chat',
        runId: RUN_ID,
        content: 'search for me'
      });
      recordRunActivity(RUN_ID);
      emitSearchingTurn(emitter());
      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: RUN_ID,
        summary: { status: 'success', content: 'The answer.', finishReason: 'stop' },
        clientConnected: true
      });

      const { messages } = await repository.getMessages(CHAT_ID);
      const answer = messages.find(m => m.role === 'assistant');
      assert.equal(answer.activity.toolActivity.items.length, 2);
      assert.equal(answer.activity.searchSummary.totalHits, 12);
      assert.equal(isRecordingRunActivity(RUN_ID), false);
    });
  });

  it('stores an activity handed over on the summary when nothing was recorded', async () => {
    await withRepository(async repository => {
      await materializeUserTurn({
        repository,
        chatId: CHAT_ID,
        ownerId: 'user-1',
        identityMode: 'default',
        appId: 'chat',
        runId: RUN_ID,
        content: 'q'
      });
      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: RUN_ID,
        summary: {
          status: 'error',
          content: '',
          finishReason: 'error',
          errorInfo: { code: 'X', message: 'x' },
          activity: { workflowResult: { status: 'failed', executionId: 'e1', workflowName: 'W' } }
        },
        clientConnected: false
      });
      const { messages } = await repository.getMessages(CHAT_ID);
      assert.equal(messages[1].activity.workflowResult.executionId, 'e1');
    });
  });
});

/** A RunLog double serving a fixed ledger. */
function fakeRunLog({ events = [], meta = null, ended = false } = {}) {
  const appended = [];
  return {
    appended,
    getRunMeta: () => meta,
    readEvents: async () => events,
    hasEnded: async () => ended,
    readStart: async () => ({ type: RUN_LOG_EVENTS.RUN_START, data: { kind: 'chat' } }),
    appendRecovered: async (runId, type, data) => {
      appended.push({ runId, type, data });
      return { runId, type, data };
    }
  };
}

const LEDGER = [
  { seq: 1, runId: RUN_ID, ts: 't1', type: RUN_LOG_EVENTS.RUN_START, data: { kind: 'chat' } },
  {
    seq: 2,
    runId: RUN_ID,
    ts: 't2',
    type: RUN_LOG_EVENTS.TOOL_CALL,
    data: {
      step: 0,
      callId: 'c1',
      toolId: 'iFinder_search',
      name: 'iFinder_search',
      args: { query: 'q' }
    }
  },
  {
    seq: 3,
    runId: RUN_ID,
    ts: 't3',
    type: RUN_LOG_EVENTS.TOOL_RESULT,
    data: {
      step: 0,
      callId: 'c1',
      toolId: 'iFinder_search',
      name: 'iFinder_search',
      resultPreview: '…',
      durationMs: 10,
      webSources: [{ documentId: 'd1', title: 'Doc' }]
    }
  }
];

describe('rebuilding the activity from the ledger', () => {
  it('recovers the tool calls of a run nobody recorded', async () => {
    const activity = await rebuildRunActivity(fakeRunLog({ events: LEDGER }), RUN_ID);
    const [item] = activity.toolActivity.items;
    assert.equal(item.query, 'q');
    assert.equal(item.status, 'completed');
    assert.deepEqual(item.sources, [{ documentId: 'd1', title: 'Doc' }]);
  });

  it('is nothing for an empty ledger', async () => {
    assert.equal(await rebuildRunActivity(fakeRunLog(), RUN_ID), null);
  });
});

describe('a chat whose run died with its process', () => {
  const longAgo = new Date(Date.now() - INTERRUPTED_RUN_GRACE_MS - 60_000).toISOString();

  it('is alive while the turn has only just claimed it', () => {
    const chat = {
      id: CHAT_ID,
      activeRunId: RUN_ID,
      status: 'running',
      lastMessageAt: new Date().toISOString()
    };
    assert.equal(isChatRunAlive(chat, { runLog: fakeRunLog() }), true);
  });

  it('is alive while the ledger knows the run — also just after it ended', () => {
    const chat = { id: CHAT_ID, activeRunId: RUN_ID, status: 'running', lastMessageAt: longAgo };
    assert.equal(isChatRunAlive(chat, { runLog: fakeRunLog({ meta: { ended: true } }) }), true);
    assert.equal(isChatRunAlive(chat, { runLog: fakeRunLog() }), false);
  });

  it('is settled with an interrupted answer, what the ledger knows, and a ledger end', async () => {
    await withRepository(async repository => {
      await materializeUserTurn({
        repository,
        chatId: CHAT_ID,
        ownerId: 'user-1',
        identityMode: 'default',
        appId: 'chat',
        runId: RUN_ID,
        content: 'look it up'
      });
      await repository.updateChat(CHAT_ID, { lastMessageAt: longAgo });
      const chat = await repository.getChat(CHAT_ID);
      assert.equal(chat.status, 'running');

      const runLog = fakeRunLog({ events: LEDGER });
      const settled = await settleInterruptedChat(chat, { repository, runLog });

      assert.equal(settled.status, 'error');
      assert.equal(settled.activeRunId, null);
      assert.equal(settled.hasUnseenActivity, true);
      const { messages } = await repository.getMessages(CHAT_ID);
      const answer = messages[1];
      assert.equal(answer.role, 'assistant');
      assert.equal(answer.runId, RUN_ID);
      assert.equal(answer.error.code, RUN_INTERRUPTED);
      assert.equal(answer.activity.toolActivity.items[0].query, 'q');
      assert.deepEqual(
        runLog.appended.map(e => [e.type, e.data.status, e.data.error.code]),
        [[RUN_LOG_EVENTS.RUN_END, 'error', RUN_INTERRUPTED]]
      );

      // Settling again changes nothing: the chat is no longer running.
      assert.equal((await settleInterruptedChat(settled, { repository, runLog })).status, 'error');
      assert.equal((await repository.getMessages(CHAT_ID)).messages.length, 2);
    });
  });

  it('only releases a chat whose answer was stored before the process died', async () => {
    await withRepository(async repository => {
      await materializeUserTurn({
        repository,
        chatId: CHAT_ID,
        ownerId: 'user-1',
        identityMode: 'default',
        appId: 'chat',
        runId: RUN_ID,
        content: 'q'
      });
      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'the answer',
        runId: RUN_ID
      });
      await repository.updateChat(CHAT_ID, { lastMessageAt: longAgo });
      const chat = await repository.getChat(CHAT_ID);
      const runLog = fakeRunLog({ ended: true });

      const settled = await settleInterruptedChat(chat, { repository, runLog });
      assert.equal(settled.activeRunId, null);
      const { messages } = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        messages.map(m => m.content),
        ['q', 'the answer']
      );
      assert.deepEqual(runLog.appended, [], 'a ledger that ended is not ended twice');
    });
  });

  it('is settled once when another worker settles it at the same time', async () => {
    await withRepository(async repository => {
      await materializeUserTurn({
        repository,
        chatId: CHAT_ID,
        ownerId: 'user-1',
        identityMode: 'default',
        appId: 'chat',
        runId: RUN_ID,
        content: 'q'
      });
      await repository.updateChat(CHAT_ID, { lastMessageAt: longAgo });
      const chat = await repository.getChat(CHAT_ID);
      // The other worker's answer lands after this one read the transcript
      // and found none — the check this one made is already stale.
      let raced = false;
      const racing = Object.create(repository);
      racing.getMessages = async id => {
        const read = await repository.getMessages(id);
        if (!raced) {
          raced = true;
          await repository.appendMessage(CHAT_ID, {
            role: 'assistant',
            content: 'settled by the other worker',
            runId: RUN_ID
          });
        }
        return read;
      };
      const runLog = fakeRunLog({ events: LEDGER });

      await settleInterruptedChat(chat, { repository: racing, runLog });

      const { messages } = await repository.getMessages(CHAT_ID);
      assert.deepEqual(
        messages.map(m => m.content),
        ['q', 'settled by the other worker']
      );
      assert.deepEqual(runLog.appended, [], 'the worker that lost does not end the run');
    });
  });

  it('leaves a live run alone', async () => {
    const chat = { id: CHAT_ID, activeRunId: RUN_ID, status: 'running', lastMessageAt: longAgo };
    const repository = {
      getMessages: () => assert.fail('a live run is not touched')
    };
    const result = await settleInterruptedChat(chat, {
      repository,
      runLog: fakeRunLog({ meta: { ended: false } })
    });
    assert.equal(result, chat);
  });
});

describe('who may start a workflow by @mention', () => {
  const workflow = { id: 'review' };
  const permitted = { permissions: { workflows: new Set(['review']) } };

  it('needs the app to list it and the user’s groups to grant it', () => {
    assert.deepEqual(mentionAccess({ user: permitted, app: { workflows: ['review'] }, workflow }), {
      allowed: true
    });
    assert.deepEqual(mentionAccess({ user: permitted, app: { workflows: [] }, workflow }), {
      allowed: false,
      reason: 'not_in_app'
    });
    assert.deepEqual(
      mentionAccess({
        user: { permissions: { workflows: new Set() } },
        app: { workflows: ['review'] },
        workflow
      }),
      { allowed: false, reason: 'not_permitted' }
    );
  });

  it('does not tell a caller about a workflow they may not run, listed or not', () => {
    // "Not available in this app" names the workflow; for one the caller may
    // not run at all, that would confirm it exists.
    const restricted = { permissions: { workflows: new Set(['other']) } };
    assert.deepEqual(mentionAccess({ user: restricted, app: { workflows: [] }, workflow }), {
      allowed: false,
      reason: 'not_permitted'
    });
  });

  it('matches ids the way the rest of the platform does, ignoring case', () => {
    assert.deepEqual(mentionAccess({ user: permitted, app: { workflows: ['Review'] }, workflow }), {
      allowed: true
    });
  });

  it('lets an administrator run any workflow the app lists', () => {
    assert.deepEqual(
      mentionAccess({
        user: { permissions: { adminAccess: true } },
        app: { workflows: ['review'] },
        workflow
      }),
      { allowed: true }
    );
  });
});

describe('Chat with Results: a stored chat about an execution', () => {
  const STATE = {
    executionId: 'wf-exec-1',
    workflowId: 'review',
    status: 'completed',
    data: {
      topic: 'Wind farm statements',
      finalReport: '# Report\n\nThree statements object.',
      shortNote: 'n/a',
      _workflowDefinition: {
        id: 'review',
        name: { en: 'Statement review', de: 'Stellungnahmen-Prüfung' },
        nodes: [{ type: 'start', config: { inputVariables: [{ name: 'topic', type: 'string' }] } }],
        chatIntegration: { primaryOutput: 'finalReport', outputFormat: 'markdown' }
      }
    }
  };

  it('asks what the execution was asked and answers with its output', async () => {
    const { createExecutionChat } = await import('../services/workflow/executionChat.js');
    await withRepository(async repository => {
      const { chatId } = await createExecutionChat({
        repository,
        state: STATE,
        executionId: 'wf-exec-1',
        appId: 'chat',
        ownerId: 'user-1',
        identityMode: 'default',
        language: 'de',
        // Only used when the execution had no text input.
        contextMessage: 'Here are the results'
      });

      const chat = await repository.getChat(chatId);
      assert.equal(chat.ownerId, 'user-1');
      assert.equal(chat.appId, 'chat');
      assert.equal(chat.status, 'active');
      assert.deepEqual(chat.origin, { createdVia: 'workflow-execution', executionId: 'wf-exec-1' });
      const { messages } = await repository.getMessages(chatId);
      assert.deepEqual(
        messages.map(m => [m.role, m.content]),
        [
          ['user', 'Wind farm statements'],
          ['assistant', '# Report\n\nThree statements object.']
        ]
      );
      // The answer names the execution it came from.
      assert.deepEqual(messages[1].activity.workflowResult, {
        status: 'completed',
        executionId: 'wf-exec-1',
        workflowName: 'Stellungnahmen-Prüfung'
      });
      // Its own run — deleting the chat must not cascade to the execution.
      assert.notEqual(messages[0].runId, 'wf-exec-1');
    });
  });

  it('opens with the client’s question when the execution had no text input', async () => {
    const { createExecutionChat } = await import('../services/workflow/executionChat.js');
    await withRepository(async repository => {
      const state = { ...STATE, data: { ...STATE.data, topic: undefined } };
      const { chatId } = await createExecutionChat({
        repository,
        state,
        executionId: 'wf-exec-1',
        appId: 'chat',
        ownerId: 'user-1',
        identityMode: 'default',
        contextMessage: 'Here are the results from the workflow "Statement review":'
      });
      const chat = await repository.getChat(chatId);
      assert.equal(chat.title, 'Statement review');
      const { messages } = await repository.getMessages(chatId);
      assert.equal(
        messages[0].content,
        'Here are the results from the workflow "Statement review":'
      );
    });
  });

  it('reads a nested primary output, as an @workflow answer does', async () => {
    const { executionHandoff } = await import('../services/workflow/executionChat.js');
    const { outputText } = executionHandoff({
      data: {
        summary: 'not this one, although it is a long text result',
        _report: { markdown: '# The report' },
        _workflowDefinition: { chatIntegration: { primaryOutput: '_report.markdown' } }
      }
    });
    assert.equal(outputText, '# The report');
  });

  it('opens no half chat when the results cannot be stored', async () => {
    const { createExecutionChat } = await import('../services/workflow/executionChat.js');
    await withRepository(async repository => {
      const failing = Object.create(repository);
      failing.appendMessage = (chatId, message, options) =>
        message.role === 'assistant'
          ? Promise.reject(new Error('disk full'))
          : repository.appendMessage(chatId, message, options);
      const result = await createExecutionChat({
        repository: failing,
        state: STATE,
        executionId: 'wf-exec-1',
        appId: 'chat',
        ownerId: 'user-1',
        identityMode: 'default'
      });
      assert.deepEqual(result, { error: 'NOT_STORED' });
      const { items } = await repository.listChats('user-1');
      assert.deepEqual(items, [], 'the question alone is not left behind');
    });
  });

  it('refuses an execution without results', async () => {
    const { createExecutionChat } = await import('../services/workflow/executionChat.js');
    const result = await createExecutionChat({
      repository: null,
      state: { status: 'completed', data: { _internal: 'x' } },
      executionId: 'e',
      appId: 'chat',
      ownerId: 'u',
      identityMode: 'default'
    });
    assert.deepEqual(result, { error: 'NO_RESULTS' });
  });

  it('picks the longest text result when the workflow declares no primary output', async () => {
    const { executionHandoff } = await import('../services/workflow/executionChat.js');
    const { outputText } = executionHandoff({
      data: {
        a: 'short',
        b: 'the longer one',
        _hidden: 'x'.repeat(100),
        humanResponse_1: 'y'.repeat(100)
      }
    });
    assert.equal(outputText, 'the longer one');
  });
});
