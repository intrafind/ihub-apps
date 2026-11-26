// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The resume of a running chat turn with a real ledger (filesystem store), in
 * one process: what a client that replayed the ledger and then re-attached
 * with `resumeRun` ends up showing, when a step completes around the resume.
 * The forked-worker test (`chatResumeCluster.test.js`) covers the bus; it has
 * no store, so it never reads a ledger.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { createStreamState, reduceRunEvent, getRun } from '../../shared/run/runReducer.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { clients, writeStreamStart } from '../sse.js';
import { buildChatResume } from '../services/chat/chatResume.js';
import runLog, { newRunId } from '../services/loop/RunLog.js';
import { RunStreamEmitter, projectLedgerEvent } from '../services/loop/RunStream.js';
import {
  createElicitationHandler,
  openQuestionFrames,
  runWithElicitationScope
} from '../services/mcp/mcpElicitation.js';
import {
  MAX_PARTIAL_TEXT_BYTES,
  MAX_PARTIAL_TOTAL_BYTES,
  dropRun,
  recordEnvelope,
  resetPartialRunState,
  snapshotRun,
  trackedStream
} from '../services/loop/partialRunState.js';

let baseDir;

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-resume-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
});

afterAll(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A started turn: its ledger run and its stream emitter. */
async function startTurn(chatId) {
  const { runId } = await runLog.startRun({
    kind: 'chat',
    runId: newRunId('chat'),
    user: { id: 'user-1' },
    refs: { chatId }
  });
  const stream = new RunStreamEmitter({ streamId: chatId, runId });
  stream.emit('run/started', { kind: 'chat', refs: { chatId } });
  /** Complete a step the way a turn does: ledger and stream. */
  const complete = (step, content) => {
    runLog.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
      step,
      content,
      toolCalls: [],
      finishReason: 'stop'
    });
    stream.emit('step/completed', { step, content, toolCalls: [], finishReason: 'stop' });
  };
  const text = (step, content) => stream.emit('step/delta', { step, kind: 'text', content });
  return { runId, stream, complete, text };
}

/** What the client has after replaying the ledger: frames and the last seq. */
async function replayLedger(runId) {
  await runLog.flush();
  const events = await runLog.readEvents(runId);
  return { frames: events.flatMap(projectLedgerEvent), afterLedgerSeq: events.at(-1)?.seq ?? 0 };
}

/**
 * Re-attach the way the GET does: register a stream holding live frames, build
 * the resume, write it. Returns the frames written to the connection.
 */
async function reattach(chatId, runId, afterLedgerSeq, duringResume) {
  const written = [];
  const entry = {
    lastActivity: new Date(),
    held: [],
    response: { write: chunk => written.push(chunk), end: () => {} }
  };
  clients.set(chatId, entry);
  const flush = runLog.flush;
  if (duringResume) {
    // Between the snapshot and the ledger read.
    runLog.flush = async function () {
      runLog.flush = flush;
      duringResume();
      return flush.call(this);
    };
  }
  try {
    const resume = await buildChatResume({ chatId, runId, afterLedgerSeq });
    writeStreamStart(chatId, entry, { ...resume, runId });
  } finally {
    runLog.flush = flush;
  }
  const frames = () =>
    written
      .filter(chunk => chunk.startsWith('data: '))
      .map(chunk => JSON.parse(chunk.slice('data: '.length)));
  return { frames, close: () => clients.delete(chatId) };
}

function runOf(frames, runId) {
  const state = frames.reduce(reduceRunEvent, createStreamState());
  return getRun(state, runId);
}

describe('resume with a ledger', () => {
  test('a step that completed after the client replayed comes before the next step’s text', async () => {
    const chatId = 'chat-resume-after-replay';
    const turn = await startTurn(chatId);
    turn.text(0, 'Hello ');
    turn.text(0, 'world');
    const replay = await replayLedger(turn.runId);
    turn.complete(0, 'Hello world');
    turn.text(1, 'Bye');

    const stream = await reattach(chatId, turn.runId, replay.afterLedgerSeq);
    turn.text(1, ' now');
    turn.complete(1, 'Bye now');
    turn.stream.emit('run/ended', { status: 'completed', finishReason: 'stop' });
    stream.close();

    const run = runOf([...replay.frames, ...stream.frames()], turn.runId);
    expect(run.steps[0].text).toBe('Hello world');
    expect(run.steps[1].text).toBe('Bye now');
    expect(run.text).toBe('Hello worldBye now');
    expect(run.status).toBe('completed');
  });

  test('a step completing between the snapshot and the ledger read is not doubled', async () => {
    const chatId = 'chat-resume-during';
    const turn = await startTurn(chatId);
    turn.text(0, 'One');
    const replay = await replayLedger(turn.runId);

    const stream = await reattach(chatId, turn.runId, replay.afterLedgerSeq, () => {
      turn.complete(0, 'One');
      turn.text(1, 'Two');
    });
    turn.complete(1, 'Two');
    turn.stream.emit('run/ended', { status: 'completed', finishReason: 'stop' });
    stream.close();

    const frames = stream.frames();
    const run = runOf([...replay.frames, ...frames], turn.runId);
    expect(run.steps[0].text).toBe('One');
    expect(run.steps[1].text).toBe('Two');
    expect(run.text).toBe('OneTwo');
    // The snapshot's text of step 0 was dropped: the ledger completed it.
    const step0Text = frames.filter(f => f.type === 'step/delta' && f.data.step === 0);
    expect(step0Text).toHaveLength(0);
  });
});

describe('a question an MCP server is waiting on', () => {
  /** An InteractionService stand-in whose answer the test gives. */
  function interactions() {
    let settle;
    return {
      raise: async params => ({
        ...params,
        step: 0,
        status: 'pending',
        createdAt: new Date().toISOString()
      }),
      waitForAnswer: () => new Promise(resolve => (settle = resolve)),
      cancel: async () => {},
      answer: answer => settle({ status: 'answered', answer })
    };
  }

  test('comes back to a client that re-attaches mid-question (a reload), and goes once answered', async () => {
    const chatId = 'chat-resume-question';
    const turn = await startTurn(chatId);
    const service = interactions();
    const handler = createElicitationHandler({
      serverId: 'billing',
      serverName: 'Billing',
      interactionService: service,
      getStreamRun: () => ({ runId: turn.runId })
    });
    // The question is asked while no client is attached: its live frames are lost.
    const asked = runWithElicitationScope({ chatId, user: { id: 'user-1' } }, () =>
      handler({
        params: {
          message: 'Name the project',
          requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
        }
      })
    );
    let questionRunId;
    for (let i = 0; i < 100 && !questionRunId; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      questionRunId = openQuestionFrames(chatId, turn.runId)[0]?.runId;
    }
    expect(questionRunId).toBeDefined();
    // Only under the chat run it belongs to.
    expect(openQuestionFrames(chatId, 'chat-other-run')).toEqual([]);

    const replay = await replayLedger(turn.runId);
    const stream = await reattach(chatId, turn.runId, replay.afterLedgerSeq);
    const card = runOf([...replay.frames, ...stream.frames()], questionRunId);
    expect(card.parentRunId).toBe(turn.runId);
    expect(card.status).toBe('paused');
    expect(card.interactions[card.pendingInteractionId].prompt.message).toBe('Name the project');

    service.answer({ value: 'accept', data: { name: 'Billing' } });
    expect(await asked).toEqual({ action: 'accept', content: { name: 'Billing' } });
    stream.close();
    expect(runOf([...replay.frames, ...stream.frames()], questionRunId).status).toBe('completed');
    expect(openQuestionFrames(chatId, turn.runId)).toEqual([]);

    // On the ledger the question is a run of its own under the chat run.
    await runLog.flush();
    const events = await runLog.readEvents(questionRunId);
    expect(events.map(e => e.type)).toEqual([
      RUN_LOG_EVENTS.RUN_START,
      RUN_LOG_EVENTS.RUN_PAUSED,
      RUN_LOG_EVENTS.RUN_RESUMED,
      RUN_LOG_EVENTS.RUN_END
    ]);
    expect(events[0].data.parentRunId).toBe(turn.runId);
    expect(events.at(-1).data).toMatchObject({
      status: 'completed',
      finishReason: 'elicitation_accept'
    });
  });
});

describe('partial run state', () => {
  const envelope = (runId, type, data, rseq = 1) => ({ v: 2, runId, rseq, type, data });

  beforeEach(() => resetPartialRunState());

  test('frames without a run frame counter are not kept', () => {
    recordEnvelope({ v: 2, runId: 'r-api', type: 'run/started', data: {} }, 'chat-a');
    recordEnvelope(
      { v: 2, runId: 'r-api', type: 'step/delta', data: { step: 0, kind: 'text', content: 'x' } },
      'chat-a'
    );
    expect(snapshotRun('r-api', 'chat-a').frames).toHaveLength(0);
  });

  test('the text cap counts the text of unfinished steps only', () => {
    const half = 'a'.repeat(MAX_PARTIAL_TEXT_BYTES / 2 + 1);
    recordEnvelope(envelope('r1', 'run/started', {}), 'chat-a');
    recordEnvelope(
      envelope('r1', 'step/delta', { step: 0, kind: 'text', content: half }),
      'chat-a'
    );
    recordEnvelope(envelope('r1', 'step/completed', { step: 0, content: half }), 'chat-a');
    recordEnvelope(
      envelope('r1', 'step/delta', { step: 1, kind: 'text', content: half }),
      'chat-a'
    );
    const { frames, truncated } = snapshotRun('r1', 'chat-a');
    expect(truncated).toBe(false);
    expect(frames.map(f => [f.data.step, f.data.content.length])).toEqual([[1, half.length]]);
  });

  test('all runs together stay within a budget; the oldest go first', () => {
    const chunk = 'c'.repeat(MAX_PARTIAL_TEXT_BYTES / 2);
    const runs = Math.floor(MAX_PARTIAL_TOTAL_BYTES / chunk.length) + 2;
    for (let i = 0; i < runs; i += 1) {
      recordEnvelope(envelope(`b${i}`, 'run/started', {}), 'chat-a');
      recordEnvelope(
        envelope(`b${i}`, 'step/delta', { step: 0, kind: 'text', content: chunk }),
        'chat-a'
      );
    }
    expect(snapshotRun('b0', 'chat-a').frames).toHaveLength(0);
    expect(snapshotRun('b1', 'chat-a').frames).toHaveLength(0);
    expect(snapshotRun('b2', 'chat-a').frames).toHaveLength(1);
    expect(snapshotRun(`b${runs - 1}`, 'chat-a').frames).toHaveLength(1);
    // Ended and completed text is freed: the budget holds new runs again.
    for (let i = 2; i < runs; i += 1) recordEnvelope(envelope(`b${i}`, 'run/ended', {}), 'chat-a');
    recordEnvelope(envelope('c0', 'run/started', {}), 'chat-a');
    for (let step = 0; step < runs; step += 1) {
      recordEnvelope(envelope('c0', 'step/delta', { step, kind: 'text', content: 'x' }), 'chat-a');
      recordEnvelope(envelope('c0', 'step/completed', { step, content: 'x' }), 'chat-a');
    }
    recordEnvelope(envelope('c1', 'run/started', {}), 'chat-a');
    recordEnvelope(
      envelope('c1', 'step/delta', { step: 0, kind: 'text', content: chunk }),
      'chat-a'
    );
    expect(snapshotRun('c1', 'chat-a').frames).toHaveLength(1);
  });

  test('dropRun forgets one run and frees its share of the budget', () => {
    const chunk = 'd'.repeat(MAX_PARTIAL_TEXT_BYTES / 2);
    const fill = Math.floor(MAX_PARTIAL_TOTAL_BYTES / chunk.length);
    for (let i = 0; i < fill; i += 1) {
      recordEnvelope(envelope(`d${i}`, 'run/started', {}), 'chat-a');
      recordEnvelope(
        envelope(`d${i}`, 'step/delta', { step: 0, kind: 'text', content: chunk }),
        'chat-a'
      );
    }
    dropRun(`d${fill - 1}`);
    dropRun('unknown');
    expect(trackedStream(`d${fill - 1}`)).toBeNull();
    // The freed room takes a new run without pushing out the oldest.
    recordEnvelope(envelope('d-new', 'run/started', {}), 'chat-a');
    recordEnvelope(
      envelope('d-new', 'step/delta', { step: 0, kind: 'text', content: chunk }),
      'chat-a'
    );
    expect(snapshotRun('d0', 'chat-a').frames).toHaveLength(1);
    expect(snapshotRun('d-new', 'chat-a').frames).toHaveLength(1);
  });

  test('a cut marks its own kind and step; thinking goes on', () => {
    const big = 'b'.repeat(MAX_PARTIAL_TEXT_BYTES + 1);
    recordEnvelope(envelope('r2', 'run/started', {}), 'chat-a');
    recordEnvelope(
      envelope('r2', 'step/delta', { step: 0, kind: 'text', content: 'ok' }),
      'chat-a'
    );
    recordEnvelope(envelope('r2', 'step/delta', { step: 0, kind: 'text', content: big }), 'chat-a');
    recordEnvelope(
      envelope('r2', 'step/delta', { step: 0, kind: 'thinking', content: 'hm' }),
      'chat-a'
    );
    const { frames, truncated } = snapshotRun('r2', 'chat-a');
    expect(truncated).toBe(true);
    expect(frames.map(f => `${f.data.kind}:${f.data.content}`)).toEqual([
      'thinking:hm',
      'text:ok',
      'text:…'
    ]);
    // The cut step completes: its text is the ledger's, the next step is kept again.
    recordEnvelope(envelope('r2', 'step/completed', { step: 0, content: 'ok' }), 'chat-a');
    recordEnvelope(
      envelope('r2', 'step/delta', { step: 1, kind: 'text', content: 'go' }),
      'chat-a'
    );
    expect(snapshotRun('r2', 'chat-a')).toEqual({
      frames: [
        expect.objectContaining({ data: expect.objectContaining({ kind: 'thinking' }) }),
        expect.objectContaining({ data: { step: 1, kind: 'text', content: 'go' } })
      ],
      truncated: false
    });
  });
});
