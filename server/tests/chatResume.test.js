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
  MAX_PARTIAL_TEXT_BYTES,
  recordEnvelope,
  resetPartialRunState,
  snapshotRun
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
