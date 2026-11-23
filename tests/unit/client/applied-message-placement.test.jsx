// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A message the person sent while iHub was working, read at a step (#3191),
 * stands at that step in the answer's activity: after the calls of the steps
 * before it, before the calls of its step and the ones after, live and from the
 * stored turn.
 *
 * - `buildToolActivity` gives each call its step only for a turn that read a
 *   message at a step (a turn that read none keeps its rows as they were);
 * - `placeAppliedMessages` puts each message before the first row of its step;
 * - `ToolActivity` draws it as a row there, and shows the list of such an
 *   answer open, also when the answer is finished.
 */
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../shared/run/toolActivity.js';
import ToolActivity from '../../../client/src/features/chat/components/ToolActivity';
import { placeAppliedMessages } from '../../../client/src/features/chat/components/AppliedMessages';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      if (typeof defaultOrOptions !== 'string') {
        return options.count !== undefined ? `${key}:${options.count}` : key;
      }
      return Object.entries(options).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, value),
        defaultOrOptions
      );
    }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

beforeEach(() => {
  window.localStorage.clear();
});

const ts = seq => `2026-11-13T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}) => ({ v: 2, seq, runId: 'r1', ts: ts(seq), type, data });
const call = (seq, step, callId) => [
  env(seq, 'tool/started', {
    step,
    callId,
    toolId: `tool_${callId}`,
    name: `tool_${callId}`,
    title: `Call ${callId}`,
    execution: 'server',
    args: {}
  }),
  env(seq + 1, 'tool/completed', {
    step,
    callId,
    toolId: `tool_${callId}`,
    name: `tool_${callId}`,
    durationMs: 10
  })
];
const read = (seq, id, step) =>
  env(seq, 'steer/applied', {
    id,
    kind: 'steer',
    text: `Message ${id}`,
    step,
    activityKind: 'user_message'
  });
const runOf = frames =>
  getRun(
    reduceRunEvents(createStreamState('c1'), [
      env(1, 'run/started', { kind: 'chat' }),
      ...frames,
      env(90, 'run/ended', { status: 'completed' })
    ]),
    'r1'
  );

describe('the steps of the calls', () => {
  test('a turn that read a message at a step gives each call its step', () => {
    const activity = buildToolActivity(
      runOf([...call(2, 1, 'a'), read(4, 's1', 2), ...call(5, 2, 'b'), ...call(7, 3, 'c')])
    );
    expect(activity.items.map(item => [item.id, item.step])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ]);
  });

  test('a turn that read none keeps its rows as they were', () => {
    const activity = buildToolActivity(runOf([...call(2, 1, 'a'), ...call(5, 2, 'b')]));
    expect(activity.items.every(item => !('step' in item))).toBe(true);
  });

  test('a message sent as the next turn does not count', () => {
    const activity = buildToolActivity(
      runOf([
        ...call(2, 1, 'a'),
        env(4, 'steer/applied', { id: 'n1', kind: 'steer', text: 'x', nextRunId: 'r2' })
      ])
    );
    expect('step' in activity.items[0]).toBe(false);
  });
});

describe('placeAppliedMessages', () => {
  const rows = [{ id: 'a', step: 1 }, { id: 'skill' }, { id: 'b', step: 2 }, { id: 'c', step: 3 }];
  const order = placed =>
    placed.map(row => (row.type === 'item' ? row.item.id : `msg:${row.entry.id}`));

  test('a message goes before the first row of its step', () => {
    expect(order(placeAppliedMessages(rows, [{ id: 's1', step: 2 }]))).toEqual([
      'a',
      'skill',
      'msg:s1',
      'b',
      'c'
    ]);
  });

  test('messages of one step keep their order; a message past the last row goes last', () => {
    expect(
      order(
        placeAppliedMessages(rows, [
          { id: 's1', step: 3 },
          { id: 's2', step: 3 },
          { id: 's3', step: 4 }
        ])
      )
    ).toEqual(['a', 'skill', 'b', 'msg:s1', 'msg:s2', 'c', 'msg:s3']);
  });

  test('rows without a step (stored before steps were kept) put the message last', () => {
    expect(
      order(placeAppliedMessages([{ id: 'a' }, { id: 'b' }], [{ id: 's1', step: 1 }]))
    ).toEqual(['a', 'b', 'msg:s1']);
  });
});

describe('ToolActivity with a message read at a step', () => {
  const applied = [
    { id: 's1', text: 'Use the 2025 numbers', step: 2, activityKind: 'user_message' }
  ];

  test('draws the message between the rows of the step before and of its step, list open when finished', () => {
    const activity = buildToolActivity(
      runOf([...call(2, 1, 'a'), read(4, 's1', 2), ...call(5, 2, 'b'), ...call(7, 3, 'c')])
    );
    render(<ToolActivity activity={activity} loading={false} applied={applied} />);
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    const texts = rows.map(row => row.textContent);
    const at = rows.findIndex(row => row.getAttribute('data-testid') === 'applied-message');
    expect(at).toBe(1);
    expect(texts[0]).toContain('Call a');
    expect(texts[1]).toContain('Use the 2025 numbers');
    expect(texts[1]).toContain('Sent while iHub was working');
    expect(texts[2]).toContain('Call b');
    expect(texts[3]).toContain('Call c');
  });

  test('the stored activity of the same answer places it the same way', () => {
    const live = buildToolActivity(
      runOf([...call(2, 1, 'a'), read(4, 's1', 2), ...call(5, 2, 'b')])
    );
    // The stored copy keeps the rows and their steps (`boundStoredActivity`).
    const stored = JSON.parse(JSON.stringify({ items: live.items, reading: null }));
    render(<ToolActivity activity={stored} loading={false} applied={applied} />);
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
      null,
      'applied-message',
      null
    ]);
  });

  test('an answer without activity rows still shows the message', () => {
    render(<ToolActivity activity={null} loading={false} applied={applied} />);
    expect(screen.getByTestId('applied-message')).toHaveTextContent('Use the 2025 numbers');
  });

  test('an activity item this client does not know is not drawn, and the list stays as it was', () => {
    const activity = buildToolActivity(runOf([...call(2, 1, 'a')]));
    render(
      <ToolActivity
        activity={activity}
        loading={false}
        applied={[{ id: 's9', text: 'x', step: 1, activityKind: 'something_new' }]}
      />
    );
    expect(screen.queryByTestId('applied-message')).toBeNull();
    // Finished and closed, as without the field.
    expect(screen.queryByRole('list')).toBeNull();
  });
});
