// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `settleActivity` (issue #3534): the activity of a message whose turn was
 * stopped, failed in transport or was answered by the user must not keep
 * showing a running clock or a pending approval.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../shared/run/toolActivity.js';
import { settleActivity } from '../../../client/src/features/chat/settleActivity';
import ToolActivity from '../../../client/src/features/chat/components/ToolActivity';

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
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const writing = {
  id: 'c1',
  kind: 'tool',
  name: 'create_web_artifact',
  toolId: 'create_web_artifact',
  outputKind: 'webArtifact',
  status: 'preparing',
  started: false,
  ready: false,
  argBytes: 41000,
  elapsedMs: 41000,
  receivedAt: 0
};
const ran = { ...writing, id: 'c0', status: 'completed', started: true };
const idle = { kind: 'waiting', elapsedMs: 41000, receivedAt: 0 };

describe('settleActivity', () => {
  test('returns the same object when there is nothing to settle', () => {
    const activity = { items: [writing], reading: null };
    expect(settleActivity(activity, {})).toBe(activity);
    expect(settleActivity(activity)).toBe(activity);
    expect(settleActivity(null, { interrupted: true })).toBeNull();
    expect(settleActivity(undefined, { interrupted: true })).toBeUndefined();
  });

  test('an interrupted turn stops every row that was still going and drops the idle line', () => {
    const activity = {
      items: [ran, writing, { ...writing, id: 'c2', status: 'running', started: true }],
      reading: 'https://example.com',
      idle,
      answering: true
    };
    const settled = settleActivity(activity, { interrupted: true });
    expect(settled.items.map(item => item.status)).toEqual(['completed', 'stopped', 'stopped']);
    expect(settled.items[0]).toBe(ran);
    expect(settled.idle).toBeUndefined();
    expect(settled.answering).toBeUndefined();
    expect(settled.reading).toBeNull();
    expect(activity.items[1].status).toBe('preparing');
  });

  test('a call that was ready to run but never started is stopped, not "ready"', () => {
    const [row] = settleActivity(
      { items: [{ ...writing, ready: true }] },
      { interrupted: true }
    ).items;
    expect(row).toMatchObject({ status: 'stopped', ready: false });
  });

  test('a decided approval takes its row away; the card shows the decision', () => {
    const awaiting = { ...writing, id: 'c3', status: 'awaiting', ready: true };
    const settled = settleActivity({ items: [ran, awaiting] }, { decided: true });
    expect(settled.items.map(item => item.id)).toEqual(['c0']);
  });

  test('a pending approval is kept while nothing was decided or interrupted', () => {
    const awaiting = { ...writing, status: 'awaiting', ready: true };
    expect(settleActivity({ items: [awaiting] }, {}).items).toHaveLength(1);
  });
});

// Frames shaped as the server sends them, through the real reducer and projection.
let seq = 0;
const env = (type, data = {}) => ({
  v: 2,
  seq: ++seq,
  runId: 'r1',
  ts: new Date(Date.UTC(2026, 10, 9, 10, 0, seq)).toISOString(),
  type,
  data
});
const progress = (phase, callId, toolId, data) =>
  env('tool/progress', { step: 0, callId, toolId, phase, data });
const activityOf = events => {
  seq = 0;
  const state = reduceRunEvents(createStreamState('s'), [
    env('run/started', { kind: 'chat', refs: {} }),
    ...events
  ]);
  return buildToolActivity(getRun(state, 'r1'));
};
const writingArtifact = progress('args', 'c1', 'create_web_artifact', {
  name: 'create_web_artifact',
  title: 'Create interactive web artifact',
  activityKind: 'tool',
  outputKind: 'webArtifact',
  argBytes: 41000,
  elapsedMs: 41000
});

describe('ToolActivity after the turn ended', () => {
  test('the idle line is not drawn once the message is no longer loading', () => {
    const { container, rerender } = render(<ToolActivity activity={{ items: [], idle }} loading />);
    expect(screen.getByText('Waiting for the model…')).toBeInTheDocument();
    rerender(<ToolActivity activity={{ items: [], idle }} loading={false} />);
    expect(screen.queryByText('Waiting for the model…')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  test('a call the user stopped while it was written reads as stopped, not as being written', () => {
    const activity = activityOf([
      writingArtifact,
      progress('model.waiting', undefined, undefined, { elapsedMs: 3000 })
    ]);
    expect(activity.items[0].status).toBe('preparing');
    const settled = settleActivity(activity, { interrupted: true });
    render(<ToolActivity activity={settled} loading={false} />);
    expect(screen.getByRole('button')).toHaveTextContent('Stopped');
    expect(screen.queryByText('Waiting for the model…')).toBeNull();
  });
});

describe('the name of a call that never started', () => {
  // A tool without an output kind and without a title: its name is its id.
  const plainFrame = progress('args', 'p1', 'my_tool', {
    name: 'my_tool',
    activityKind: 'tool',
    argBytes: 100,
    elapsedMs: 2000
  });
  const ended = outcome =>
    progress('args.ended', 'p1', 'my_tool', { outcome, argBytes: 100, elapsedMs: 2500 });

  test.each([
    ['aborted', 'stopped'],
    ['truncated', 'error']
  ])('a call that ended %s reads as its name, never "Ran my_tool"', (outcome, status) => {
    const activity = activityOf([plainFrame, ended(outcome)]);
    expect(activity.items[0]).toMatchObject({ status, started: false });
    render(<ToolActivity activity={activity} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('my_tool')).toBeInTheDocument();
    expect(screen.queryByText(/^Ran /)).toBeNull();
  });

  test('a call that ran still reads "Ran my_tool"', () => {
    const activity = activityOf([
      plainFrame,
      ended('ready'),
      env('tool/started', {
        step: 0,
        callId: 'p1',
        toolId: 'my_tool',
        name: 'my_tool',
        args: {},
        execution: 'server'
      }),
      env('tool/completed', {
        step: 0,
        callId: 'p1',
        toolId: 'my_tool',
        name: 'my_tool',
        resultPreview: 'ok'
      }),
      env('run/ended', { status: 'completed', finishReason: 'stop' })
    ]);
    render(<ToolActivity activity={activity} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Ran my_tool')).toBeInTheDocument();
  });
});
