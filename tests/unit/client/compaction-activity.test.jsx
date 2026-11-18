// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Earlier results condensed to free context (#3819): the `context/compacted`
 * frames fold into the run, become a row of the answer's activity placed by
 * time, and the row says what happened — the server's facts only.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../shared/run/toolActivity.js';
import ToolActivity from '../../../client/src/features/chat/components/ToolActivity';
import { headlineOf } from '../../../client/src/features/chat/activityHeadline.js';
import { withServerDecision } from './helpers/serverToolDecision.js';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      if (typeof defaultOrOptions !== 'string') {
        return options.count !== undefined ? `${key}:${options.count}` : key;
      }
      return defaultOrOptions;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name, className }) => (
    <span data-testid="icon" data-name={name} className={className} />
  )
}));

afterEach(cleanup);

const t = (key, options = {}) => (options.count !== undefined ? `${key}:${options.count}` : key);
const ts = seq => `2026-11-18T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}) => ({
  v: 2,
  seq,
  runId: 'run-1',
  ts: ts(seq),
  type,
  data: withServerDecision(type, data)
});
const started = env(1, 'run/started', { kind: 'chat', refs: { chatId: 'chat-1' } });
const search = (seq, callId) => [
  env(seq, 'tool/started', {
    step: seq,
    callId,
    toolId: 'braveSearch',
    name: 'braveSearch',
    args: { query: callId },
    execution: 'server'
  }),
  env(seq + 1, 'tool/completed', {
    step: seq,
    callId,
    toolId: 'braveSearch',
    name: 'braveSearch',
    resultPreview: '{}',
    durationMs: 10
  })
];
const compacted = (seq, status, extra = {}) =>
  env(seq, 'context/compacted', {
    compactionId: 'cmp-1',
    step: 2,
    status,
    trigger: 'proactive',
    strategy: 'digest',
    lossy: false,
    itemsSummarised: 9,
    kinds: { search: 9, fetch: 0, tool: 0 },
    tokensBefore: 102934,
    ...extra
  });
const DIGEST =
  '<condensed_results digest="1" refs="r1-r9">\nFacts:\n- [r1] NVIDIA 5.1T\n</condensed_results>';
const done = compacted(14, 'completed', { tokensAfter: 37905, digest: DIGEST, facts: 12 });

function runFrom(envelopes) {
  return getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');
}

describe('context/compacted in the run', () => {
  test('the running frame and the completed one are one entry, at the time it first appeared', () => {
    const run = runFrom([started, compacted(4, 'running'), done]);
    expect(run.compactions).toHaveLength(1);
    expect(run.compactions[0]).toMatchObject({
      status: 'completed',
      tokensAfter: 37905,
      at: ts(4)
    });
  });

  test('the row sits between the calls it came after and the ones that followed', () => {
    const run = runFrom([
      started,
      ...search(2, 'a'),
      compacted(4, 'running'),
      { ...done, seq: 5, ts: ts(5) },
      ...search(6, 'b'),
      env(9, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ]);
    const { items } = buildToolActivity(run);
    expect(items.map(item => item.kind)).toEqual(['search', 'compaction', 'search']);
    expect(items[1]).toMatchObject({
      id: 'compaction-cmp-1',
      status: 'completed',
      lossy: false,
      strategy: 'digest',
      itemsSummarised: 9,
      digest: DIGEST,
      facts: 12
    });
  });

  test('a turn that ended while the notes were written shows the row as stopped', () => {
    const run = runFrom([
      started,
      ...search(2, 'a'),
      compacted(4, 'running'),
      env(5, 'run/ended', { status: 'aborted', finishReason: 'cancelled' })
    ]);
    expect(buildToolActivity(run).items[1].status).toBe('stopped');
  });
});

describe('the compaction row', () => {
  test('while the notes are written, the headline says so', () => {
    const activity = buildToolActivity(
      runFrom([started, ...search(2, 'a'), compacted(4, 'running')])
    );
    expect(headlineOf(t, activity, true).label).toBe('toolActivity.compaction.running');
    render(<ToolActivity activity={activity} loading />);
    expect(screen.getAllByText('toolActivity.compaction.running').length).toBeGreaterThan(0);
  });

  test('once done, the summary names it and the row opens to the notes', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        ...search(2, 'a'),
        compacted(4, 'running'),
        { ...done, seq: 5, ts: ts(5) },
        env(6, 'run/ended', { status: 'completed', finishReason: 'stop' })
      ])
    );
    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getAllByRole('button')[0];
    expect(toggle).toHaveTextContent('toolActivity.compaction.condensedSearches:9');
    fireEvent.click(toggle);
    expect(screen.queryByText('toolActivity.compaction.why')).not.toBeInTheDocument();
    expect(screen.getByText('toolActivity.compaction.facts:12')).toBeInTheDocument();
    const notes = screen.getByRole('button', { name: /toolActivity.compaction.showNotes/ });
    expect(notes).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/NVIDIA 5\.1T/)).not.toBeInTheDocument();
    fireEvent.click(notes);
    expect(notes).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/NVIDIA 5\.1T/)).toBeInTheDocument();
    expect(screen.getByText('toolActivity.compaction.why')).toBeInTheDocument();
    // The notes are shown without the block's tags.
    expect(screen.getByText(/NVIDIA 5\.1T/).textContent).not.toMatch(/condensed_results/);
  });

  test('a lossy compaction reads differently, in the attention colour', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        ...search(2, 'a'),
        compacted(4, 'completed', {
          lossy: true,
          fallbackReason: 'summary_failed',
          digest: DIGEST
        }),
        env(6, 'run/ended', { status: 'completed', finishReason: 'stop' })
      ])
    );
    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getAllByRole('button')[0];
    expect(toggle).toHaveTextContent('toolActivity.compaction.reduced:9');
    fireEvent.click(toggle);
    const hint = screen.getByText('toolActivity.compaction.lossyRecall');
    expect(hint.className).toMatch(/amber/);
    expect(
      screen.getAllByTestId('icon').some(icon => icon.dataset.name === 'exclamation-triangle')
    ).toBe(true);
  });

  test('a collapse after a full context window says the context was full', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        ...search(2, 'a'),
        compacted(4, 'completed', {
          trigger: 'overflow',
          strategy: 'elide',
          lossy: true,
          itemsSummarised: 3,
          kinds: undefined
        }),
        env(6, 'run/ended', { status: 'completed', finishReason: 'stop' })
      ])
    );
    render(<ToolActivity activity={activity} loading={false} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getAllByText('toolActivity.compaction.contextFull:3').length).toBeGreaterThan(0);
    expect(screen.getByText('toolActivity.compaction.lossyElided')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /showNotes/ })).not.toBeInTheDocument();
  });

  test('a turn whose notes were written and once had to shorten says both, not only the loss', () => {
    const second = env(8, 'context/compacted', {
      compactionId: 'cmp-2',
      step: 4,
      status: 'completed',
      trigger: 'proactive',
      strategy: 'digest',
      lossy: true,
      fallbackReason: 'compaction_limit',
      itemsSummarised: 2,
      kinds: { search: 2, fetch: 0, tool: 0 }
    });
    const activity = buildToolActivity(
      runFrom([
        started,
        ...search(2, 'a'),
        { ...done, seq: 5, ts: ts(5) },
        ...search(6, 'b'),
        second,
        env(9, 'run/ended', { status: 'completed', finishReason: 'stop' })
      ])
    );
    const label = headlineOf(t, activity, false).label;
    expect(label).toContain('toolActivity.compaction.condensedSearches:11');
    expect(label).toContain('toolActivity.compaction.someShortened:2');
  });
});
