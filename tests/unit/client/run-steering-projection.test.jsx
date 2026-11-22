// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A message the person sent into the running answer, read at a step (#3191):
 * the run reducer folds the `steer/*` frames as the server sent them, the
 * projection puts the messages read at a step on the answer, and a reopened
 * chat gets the same field from the stored messages. One component draws them
 * for both, in the same place.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  createStreamState,
  reduceRunEvents,
  getRun,
  getSteers,
  getAppliedSteers
} from '../../../shared/run/runReducer.js';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage.js';
import { transformStoredMessages } from '../../../client/src/features/chat/hooks/useChatMessages';
import AppliedMessages from '../../../client/src/features/chat/components/AppliedMessages';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key)
  })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({ __esModule: true, debugLog: () => {} }));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

let seq = 0;
const env = (runId, type, data = {}) => ({
  v: 2,
  seq: ++seq,
  runId,
  ts: new Date(seq * 1000).toISOString(),
  type,
  data
});
const fold = envelopes => reduceRunEvents(createStreamState('chat-1'), envelopes);
const started = env('run-a', 'run/started', { kind: 'chat', refs: { messageId: 'm1' } });

describe('the run reducer and messages for the running answer', () => {
  test('folds queued, read and dropped messages as the frames say', () => {
    const state = fold([
      started,
      env('run-a', 'steer/queued', { id: 's1', kind: 'steer', text: 'first' }),
      env('run-a', 'steer/queued', { id: 's2', kind: 'steer', text: 'second' }),
      env('run-a', 'steer/queued', { id: 's3', kind: 'send_after', text: 'later' }),
      env('run-a', 'steer/applied', {
        id: 's2',
        kind: 'steer',
        text: 'second',
        step: 3,
        activityKind: 'user_message'
      }),
      env('run-a', 'steer/applied', {
        id: 's1',
        kind: 'steer',
        text: 'first',
        step: 1,
        activityKind: 'user_message'
      }),
      env('run-a', 'steer/dropped', {
        id: 's3',
        kind: 'send_after',
        text: 'later',
        reason: 'run_stopped'
      })
    ]);
    const run = getRun(state, 'run-a');
    expect(getSteers(run).map(s => [s.id, s.status])).toEqual([
      ['s1', 'applied'],
      ['s2', 'applied'],
      ['s3', 'dropped']
    ]);
    expect(getSteers(run)[2].reason).toBe('run_stopped');
    // Step order, whatever order the frames came in.
    expect(getAppliedSteers(run)).toEqual([
      { id: 's1', text: 'first', step: 1, activityKind: 'user_message' },
      { id: 's2', text: 'second', step: 3, activityKind: 'user_message' }
    ]);
  });

  test('a message sent as the next turn is not part of this answer', () => {
    const run = getRun(
      fold([
        started,
        env('run-a', 'steer/applied', { id: 's1', kind: 'steer', text: 'x', nextRunId: 'run-b' })
      ]),
      'run-a'
    );
    expect(getSteers(run)[0]).toMatchObject({ status: 'applied', nextRunId: 'run-b', step: null });
    expect(getAppliedSteers(run)).toEqual([]);
  });

  test('a late queued frame does not bring back a message that was read', () => {
    const run = getRun(
      fold([
        started,
        env('run-a', 'steer/applied', {
          id: 's1',
          kind: 'steer',
          text: 'x',
          step: 2,
          activityKind: 'user_message'
        }),
        env('run-a', 'steer/queued', { id: 's1', kind: 'steer', text: 'x' })
      ]),
      'run-a'
    );
    expect(getSteers(run)[0].status).toBe('applied');
  });

  test('a frame of a run the stream never saw start makes no run', () => {
    const state = fold([
      started,
      env('run-b', 'steer/queued', { id: 's9', kind: 'steer', text: 'y' })
    ]);
    expect(getRun(state, 'run-b')).toBeNull();
    expect(state.order).toEqual(['run-a']);
  });

  test('the projection puts the messages read at a step on the answer', () => {
    const run = getRun(
      fold([
        started,
        env('run-a', 'steer/applied', {
          id: 's1',
          kind: 'steer',
          text: 'x',
          step: 1,
          activityKind: 'user_message'
        })
      ]),
      'run-a'
    );
    expect(projectRunToMessage(run).extras.appliedMessages).toEqual([
      { id: 's1', text: 'x', step: 1, activityKind: 'user_message' }
    ]);
    expect(
      projectRunToMessage(getRun(fold([started]), 'run-a')).extras.appliedMessages
    ).toBeUndefined();
  });
});

describe('a reopened chat', () => {
  const stored = [
    { id: 'q1', role: 'user', content: 'Write the report', runId: 'run-a' },
    {
      id: 'st2',
      role: 'user',
      content: 'skip the appendix',
      runId: 'run-a',
      steer: true,
      appliedAtStep: 4,
      steerId: 's2',
      activityKind: 'user_message'
    },
    {
      id: 'st1',
      role: 'user',
      content: 'use the 2025 numbers',
      runId: 'run-a',
      steer: true,
      appliedAtStep: 2,
      steerId: 's1',
      activityKind: 'user_message'
    },
    { id: 'a1', role: 'assistant', content: 'The report.', runId: 'run-a' },
    { id: 'q2', role: 'user', content: 'Thanks', runId: 'run-b' },
    {
      id: 'st3',
      role: 'user',
      content: 'read by the running answer',
      runId: 'run-b',
      steer: true,
      appliedAtStep: 1,
      steerId: 's3',
      activityKind: 'user_message'
    }
  ];

  test('draws a stored message inside the answer of its run, in step order', () => {
    const messages = transformStoredMessages(stored);
    expect(messages.map(m => m.id)).toEqual(['q1', 'a1', 'q2']);
    expect(messages[1].appliedMessages).toEqual([
      { id: 's1', text: 'use the 2025 numbers', step: 2, activityKind: 'user_message' },
      { id: 's2', text: 'skip the appendix', step: 4, activityKind: 'user_message' }
    ]);
  });

  test('a message of an answer that is not stored yet is left to the replay of that answer', () => {
    const messages = transformStoredMessages(stored);
    expect(messages.some(m => m.content === 'read by the running answer')).toBe(false);
    expect(messages.find(m => m.id === 'q2').appliedMessages).toBeUndefined();
  });

  test('a transcript without such messages comes out as before', () => {
    const plain = [stored[0], stored[3]];
    expect(transformStoredMessages(plain).map(m => m.appliedMessages)).toEqual([
      undefined,
      undefined
    ]);
  });
});

describe('AppliedMessages', () => {
  test('draws each message with its caption, in the order given', () => {
    render(
      <AppliedMessages
        items={[
          { id: 's1', text: 'use the 2025 numbers', step: 2, activityKind: 'user_message' },
          { id: 's2', text: 'skip the appendix', step: 4, activityKind: 'user_message' }
        ]}
      />
    );
    const list = screen.getByRole('list', { name: 'Messages sent while iHub was working' });
    const items = screen.getAllByTestId('applied-message');
    expect(list).toContainElement(items[0]);
    expect(items.map(item => item.textContent)).toEqual([
      'use the 2025 numbersSent while iHub was working',
      'skip the appendixSent while iHub was working'
    ]);
  });

  test('draws nothing for an activity item it does not know', () => {
    const { container } = render(
      <AppliedMessages items={[{ id: 's1', text: 'x', step: 1, activityKind: 'something_new' }]} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
