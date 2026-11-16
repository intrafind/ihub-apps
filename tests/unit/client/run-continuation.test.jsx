// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat turn that paused for a clarification or an approval continues under
 * the same run id once the person answers. The reducer opens the continuation
 * from a clean state on its `run/started` (or the document refresh before
 * it), so the new answer does not inherit the paused part; a ledger replay
 * (`run/paused` … `run/resumed`) keeps one run across the pause.
 */
import {
  createStreamState,
  reduceRunEvents,
  getRun,
  continuesRun
} from '../../../shared/run/runReducer.js';
import { KNOWLEDGE_REFRESH_PHASE } from '../../../shared/run/knowledgeRefresh.js';
import { lastLifecycleType } from '../../../client/src/shared/run/ledgerPages.js';

const env = (seq, type, data = {}) => ({
  v: 2,
  seq,
  runId: 'run-1',
  ts: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  data
});
const started = (seq, messageId) =>
  env(seq, 'run/started', { kind: 'chat', refs: { chatId: 'chat-1', messageId } });
const interaction = {
  id: 'i1',
  runId: 'run-1',
  kind: 'approval',
  origin: 'tool',
  status: 'pending',
  prompt: { message: 'Run dangerous?' },
  source: { chatId: 'chat-1', toolCallId: 'call_1' },
  createdAt: '2026-11-16T10:00:00.000Z'
};
const pausedTurn = [
  started(1, 'msg-1'),
  env(2, 'step/delta', { step: 1, kind: 'text', content: 'I will update the ticket.' }),
  env(3, 'interaction/raised', { interaction }),
  env(4, 'run/paused', { reason: 'interaction', interactionId: 'i1' })
];

const runOf = envelopes => getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');

describe('a paused run continued under its own id', () => {
  test('run/started opens the continuation from a clean state', () => {
    const run = runOf([
      ...pausedTurn,
      started(5, 'msg-2'),
      env(6, 'step/delta', { step: 1, kind: 'text', content: 'Done.' })
    ]);
    expect(run.status).toBe('running');
    expect(run.text).toBe('Done.');
    expect(run.refs.messageId).toBe('msg-2');
    expect(run.interactions).toEqual({});
    expect(run.pendingInteractionId ?? null).toBeNull();
  });

  test('the document refresh before the turn starts opens it too', () => {
    const refresh = env(5, 'tool/progress', {
      phase: KNOWLEDGE_REFRESH_PHASE,
      data: { total: 2, done: 0 }
    });
    expect(continuesRun(runOf(pausedTurn), refresh)).toBe(true);
    const run = runOf([...pausedTurn, refresh]);
    expect(run.status).toBe('running');
    expect(run.text).toBe('');
  });

  test('a ledger replay keeps one run across the pause', () => {
    const run = runOf([
      ...pausedTurn,
      env(5, 'run/resumed', { interactionId: 'i1' }),
      env(6, 'step/delta', { step: 2, kind: 'text', content: ' Done.' })
    ]);
    expect(run.status).toBe('running');
    expect(run.text).toBe('I will update the ticket. Done.');
    expect(run.interactions.i1.status).toBe('answered');
  });

  test('a running run is never reset', () => {
    const live = runOf([started(1, 'msg-1')]);
    expect(continuesRun(live, started(2, 'msg-1'))).toBe(false);
    expect(continuesRun(undefined, started(1, 'msg-1'))).toBe(false);
  });
});

describe('a reattach replay of a continued run', () => {
  test('ends where its last lifecycle frame is', () => {
    const resumed = env(5, 'run/resumed', { interactionId: 'i1' });
    expect(lastLifecycleType([...pausedTurn, resumed])).toBe('run/resumed');
    expect(lastLifecycleType(pausedTurn)).toBe('run/paused');
    expect(lastLifecycleType([...pausedTurn, resumed, env(6, 'run/ended', {})])).toBe('run/ended');
    expect(lastLifecycleType([])).toBeNull();
  });
});
