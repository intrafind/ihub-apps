// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a screen reader is told while a turn writes a file or waits (#3534): the
 * pure script (`deriveAnnouncements`), its queue, the live region that speaks it
 * (`RunAnnouncer`), where that region sits (`ChatMessageList`), and the
 * three-dot loader standing down for the activity headline (`ChatMessage`).
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../shared/run/toolActivity.js';
import {
  createAnnouncerState,
  deriveAnnouncements,
  enqueueAnnouncements,
  spoken,
  takeAnnouncement
} from '../../../client/src/features/chat/deriveAnnouncements.js';
import RunAnnouncer from '../../../client/src/features/chat/components/RunAnnouncer';
import ChatMessageList from '../../../client/src/features/chat/components/ChatMessageList';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

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

jest.mock('../../../client/src/utils/debugLog', () => ({ __esModule: true, debugLog: () => {} }));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));
jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/StarRating', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() },
  default: { get: jest.fn(), post: jest.fn() }
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  buildPath: path => path
}));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

// ── fixtures ───────────────────────────────────────────────────────────────

const t = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  if (typeof defaultOrOptions !== 'string') return key;
  return Object.entries(options).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    defaultOrOptions
  );
};

const ARTIFACT = 'create_web_artifact';
const env = (seq, type, data = {}, extra = {}) => ({
  v: 2,
  seq,
  runId: 'run-1',
  ts: `2026-09-22T10:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  data,
  ...extra
});
const progress = (seq, phase, frame, data, extra) =>
  env(seq, 'tool/progress', { phase, step: 1, ...frame, data }, extra);
const args = (seq, callId, receivedAt, data = {}) =>
  progress(
    seq,
    'args',
    { callId, toolId: ARTIFACT },
    {
      name: ARTIFACT,
      title: 'Create web artifact',
      outputKind: 'webArtifact',
      argBytes: 12288,
      elapsedMs: 41000,
      ...data
    },
    { receivedAt }
  );
const argsEnded = (seq, callId, receivedAt, outcome, data = {}) =>
  progress(
    seq,
    'args.ended',
    { callId, toolId: ARTIFACT },
    { outcome, argBytes: 20000, elapsedMs: 60000, ...data },
    { receivedAt }
  );
const toolStarted = (seq, callId) =>
  env(seq, 'tool/started', {
    step: 1,
    callId,
    toolId: ARTIFACT,
    name: ARTIFACT,
    args: {},
    execution: 'server'
  });
const toolCompleted = (seq, callId) =>
  env(seq, 'tool/completed', { step: 1, callId, toolId: ARTIFACT, name: ARTIFACT });
const runStarted = env(1, 'run/started', { kind: 'chat', refs: { chatId: 'c' } });
const aborted = seq => env(seq, 'run/ended', { status: 'aborted', finishReason: 'x' });

const activityOf = frames =>
  buildToolActivity(
    getRun(reduceRunEvents(createStreamState('c'), [runStarted, ...frames]), 'run-1')
  );
const assistant = (frames, extra = {}) => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  loading: true,
  toolActivity: activityOf(frames),
  ...extra
});
const user = { id: 'u1', role: 'user', content: 'Make a calculator' };

const T0 = 100000;
const derive = (state, messages, now) => deriveAnnouncements(state, messages, { t, now });
const texts = result => result.announcements.map(a => a.text);

// ── the script ─────────────────────────────────────────────────────────────

describe('deriveAnnouncements', () => {
  test('announces a file call once it is shown, not while it is still in its grace period', () => {
    const messages = [user, assistant([args(2, 'x1', T0)])];
    const early = derive(createAnnouncerState(), messages, T0 + 100);
    expect(early.announcements).toEqual([]);
    // It looks again when the grace ends.
    expect(early.wakeInMs).toBeGreaterThan(0);
    expect(early.wakeInMs).toBeLessThanOrEqual(400);
    const later = derive(early.state, messages, T0 + 500);
    expect(later.announcements).toEqual([
      { key: 'x1:start', text: 'Creating web artifact', priority: 'normal' }
    ]);
  });

  test('says each event once, however often it is asked', () => {
    const messages = [user, assistant([args(2, 'x1', T0)])];
    const first = derive(createAnnouncerState(), messages, T0 + 600);
    const second = derive(first.state, messages, T0 + 700);
    const third = derive(second.state, messages, T0 + 5000);
    expect(first.announcements).toHaveLength(1);
    expect(second.announcements).toEqual([]);
    expect(third.announcements.map(a => a.key)).not.toContain('x1:start');
  });

  test('says nothing about sizes or the clock, only words', () => {
    const frames = [
      args(2, 'x1', T0, { argBytes: 12288, elapsedMs: 41000 }),
      argsEnded(3, 'x1', T0 + 1000, 'ready'),
      toolStarted(4, 'x1'),
      toolCompleted(5, 'x1')
    ];
    let state = createAnnouncerState();
    const said = [];
    for (let i = 2; i <= frames.length + 1; i++) {
      const result = derive(state, [user, assistant(frames.slice(0, i - 1))], T0 + 1000 * i);
      state = result.state;
      said.push(...texts(result));
    }
    expect(said).toEqual(['Creating web artifact', 'Created web artifact']);
    for (const text of said) expect(text).not.toMatch(/\d|KB|written/);
  });

  test('says that a file is done, with high priority', () => {
    const frames = [
      args(2, 'x1', T0),
      argsEnded(3, 'x1', T0 + 1000, 'ready'),
      toolStarted(4, 'x1'),
      toolCompleted(5, 'x1')
    ];
    // Seen while it was written, then done.
    const writing = derive(createAnnouncerState(), [assistant(frames.slice(0, 1))], T0 + 600);
    expect(writing.announcements.map(a => [a.key, a.priority])).toEqual([['x1:start', 'normal']]);
    const done = derive(writing.state, [assistant(frames)], T0 + 2000);
    expect(done.announcements.map(a => [a.key, a.priority])).toEqual([['x1:done', 'high']]);
  });

  test.each([
    ['truncated', 'Incomplete — the model reached its output limit before the call was finished.'],
    ['invalid', 'Incomplete — the call data from the model could not be read.']
  ])('says why a call that ended %s failed, as the most important thing', (outcome, reason) => {
    const frames = [args(2, 'x1', T0), argsEnded(3, 'x1', T0 + 900, outcome)];
    const result = derive(createAnnouncerState(), [assistant(frames)], T0 + 1000);
    expect(result.announcements.find(a => a.key === 'x1:failed')).toEqual({
      key: 'x1:failed',
      text: `Web artifact: Failed. ${reason}`,
      priority: 'highest'
    });
  });

  test('says nothing about a call that was refused before it was ever shown', () => {
    const frames = [args(2, 'x1', T0), argsEnded(3, 'x1', T0 + 100, 'dropped')];
    const result = derive(createAnnouncerState(), [assistant(frames)], T0 + 9000);
    expect(result.announcements).toEqual([]);
    expect(result.wakeInMs).toBeNull();
  });

  test('says that a file was stopped, or written but not run', () => {
    const stopped = derive(
      createAnnouncerState(),
      [assistant([args(2, 'x1', T0), aborted(4)], { loading: true })],
      T0 + 2000
    );
    expect(texts(stopped)).toContain('Stopped — the unfinished call was not run.');
    const notRun = derive(
      createAnnouncerState(),
      [assistant([args(2, 'x1', T0), argsEnded(3, 'x1', T0 + 900, 'ready'), aborted(4)])],
      T0 + 2000
    );
    expect(texts(notRun)).toContain('Not run');
  });

  test('says when a call waits for approval', () => {
    const approval = env(4, 'interaction/raised', {
      interaction: {
        id: 'a1',
        kind: 'approval',
        origin: 'tool',
        status: 'pending',
        source: { toolCallId: 'x1' }
      }
    });
    const frames = [args(2, 'x1', T0), argsEnded(3, 'x1', T0 + 900, 'ready'), approval];
    // The turn was under way, then hands control to the user (it is not loading any more).
    const writing = derive(createAnnouncerState(), [assistant(frames.slice(0, 1))], T0 + 600);
    const result = derive(writing.state, [assistant(frames, { loading: false })], T0 + 2000);
    expect(result.announcements.find(a => a.key === 'x1:awaiting')).toMatchObject({
      text: 'Waiting for approval',
      priority: 'high'
    });
  });

  test('says once that nothing has grown for a while, and looks again in time', () => {
    const frames = [args(2, 'x1', T0, { argBytes: 8192, elapsedMs: 10000 })];
    const messages = [assistant(frames)];
    const soon = derive(createAnnouncerState(), messages, T0 + 1000);
    // The caption is due when the clock reaches 0:30.
    expect(soon.wakeInMs).toBe(19000);
    expect(texts(soon)).toEqual(['Creating web artifact']);
    const due = derive(soon.state, messages, T0 + 20000);
    expect(due.announcements).toEqual([
      {
        key: 'x1:stalled',
        text: 'No new output for a while. The model may be busy — you can wait or stop.',
        priority: 'normal'
      }
    ]);
    expect(texts(derive(due.state, messages, T0 + 30000))).toEqual([]);
  });

  test('says "Waiting for the model" or "Thinking" once per step, after it has been up for a while', () => {
    const waiting = (seq, data) => progress(seq, 'model.waiting', {}, data, { receivedAt: T0 });
    const messages = [assistant([waiting(2, { elapsedMs: 3000 })])];
    const shown = derive(createAnnouncerState(), messages, T0);
    expect(shown.announcements).toEqual([]);
    expect(shown.wakeInMs).toBe(5000);
    const heard = derive(shown.state, messages, T0 + 5000);
    expect(heard.announcements).toEqual([
      { key: 'idle:waiting:1', text: 'Waiting for the model', priority: 'low' }
    ]);
    expect(texts(derive(heard.state, messages, T0 + 20000))).toEqual([]);
    // A later step is a new event.
    const next = [assistant([waiting(2, { elapsedMs: 3000, reasoning: true })])];
    const thinking = derive(derive(heard.state, next, T0 + 30000).state, next, T0 + 35000);
    expect(texts(thinking)).toEqual(['Thinking']);
  });

  test('does not announce a skill row', () => {
    const skill = env(2, 'tool/progress', {
      phase: 'skill.activation',
      message: 'Research',
      data: { skillName: 'Research', skillId: 'research', activatedBy: 'user' }
    });
    const result = derive(createAnnouncerState(), [assistant([skill])], T0);
    expect(result.announcements).toEqual([]);
  });

  test('starts afresh for each turn', () => {
    const frames = [args(2, 'x1', T0)];
    const first = derive(createAnnouncerState(), [assistant(frames, { id: 'm1' })], T0 + 600);
    expect(texts(first)).toEqual(['Creating web artifact']);
    // The same call id in the next turn is a different event.
    const next = derive(first.state, [assistant(frames, { id: 'm2' })], T0 + 700);
    expect(texts(next)).toEqual(['Creating web artifact']);
  });

  test('does not read out a turn that is already over when it first shows up', () => {
    const frames = [
      args(2, 'x1', T0),
      argsEnded(3, 'x1', T0 + 900, 'ready'),
      toolStarted(4, 'x1'),
      toolCompleted(5, 'x1')
    ];
    const history = assistant(frames, { loading: false });
    const first = derive(createAnnouncerState(), [user, history], T0 + 9000);
    expect(first.announcements).toEqual([]);
    expect(first.wakeInMs).toBeNull();
    // And it stays quiet afterwards.
    expect(derive(first.state, [user, history], T0 + 10000).announcements).toEqual([]);
  });

  test('has nothing to say without an assistant message', () => {
    expect(derive(createAnnouncerState(), [], T0).announcements).toEqual([]);
    expect(derive(createAnnouncerState(), undefined, T0).announcements).toEqual([]);
    expect(derive(createAnnouncerState(), [user], T0).announcements).toEqual([]);
  });

  test('spoken() drops the ellipsis and capitalises', () => {
    expect(spoken('Creating web artifact…')).toBe('Creating web artifact');
    expect(spoken('Waiting for the model...')).toBe('Waiting for the model');
    expect(spoken('web artifact')).toBe('Web artifact');
  });
});

describe('the announcement queue', () => {
  const said = (key, priority) => ({ key, text: key, priority });

  test('keeps three at most and drops the least important first, the oldest of equals', () => {
    let queue = enqueueAnnouncements(
      [],
      [said('a', 'normal'), said('b', 'low'), said('c', 'high')]
    );
    expect(queue.map(a => a.key)).toEqual(['a', 'b', 'c']);
    queue = enqueueAnnouncements(queue, [said('d', 'normal')]);
    expect(queue.map(a => a.key)).toEqual(['a', 'c', 'd']);
    queue = enqueueAnnouncements(queue, [said('e', 'highest'), said('f', 'highest')]);
    expect(queue.map(a => a.key)).toEqual(['c', 'e', 'f']);
  });

  test('speaks the most important first, and never two within 1.5 s', () => {
    const queue = [said('a', 'normal'), said('b', 'highest'), said('c', 'highest')];
    const first = takeAnnouncement(queue, null, 1000);
    expect(first.announcement.key).toBe('b');
    expect(first.queue.map(a => a.key)).toEqual(['a', 'c']);
    const tooSoon = takeAnnouncement(first.queue, 1000, 2000);
    expect(tooSoon.announcement).toBeNull();
    expect(tooSoon.waitMs).toBe(500);
    expect(takeAnnouncement(first.queue, 1000, 2500).announcement.key).toBe('c');
    expect(takeAnnouncement([], null, 0)).toEqual({ announcement: null, queue: [], waitMs: null });
  });
});

// ── the live region ────────────────────────────────────────────────────────

describe('RunAnnouncer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.advanceTimersByTime(T0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const region = () => screen.getByRole('status');
  const grow = (callId = 'x1') => args(2, callId, T0, { argBytes: 12288, elapsedMs: 41000 });

  test('is one polite, atomic, visually hidden status region, there from the start', () => {
    render(<RunAnnouncer messages={[]} />);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveAttribute('aria-atomic', 'true');
    expect(region().className).toMatch(/\bsr-only\b/);
    expect(region()).toBeEmptyDOMElement();
  });

  test('speaks a call once its grace period is over, and the text goes away again', () => {
    const messages = [user, assistant([grow()])];
    render(<RunAnnouncer messages={messages} />);
    expect(region()).toBeEmptyDOMElement();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(region()).toHaveTextContent('Creating web artifact');
    // Repeated renders say it no more.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(region()).toHaveTextContent('Creating web artifact');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(region()).toBeEmptyDOMElement();
  });

  test('says which list it speaks for when several chats are visible (compare mode)', () => {
    render(<RunAnnouncer messages={[user, assistant([grow()])]} label="Model B" />);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(region()).toHaveTextContent('Model B: Creating web artifact');
  });

  test('puts two events at least 1.5 s apart, the more important one first', () => {
    const frames = [grow(), argsEnded(3, 'x1', T0 + 600, 'truncated')];
    const { rerender } = render(<RunAnnouncer messages={[assistant([grow()])]} />);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(region()).toHaveTextContent('Creating web artifact');
    rerender(<RunAnnouncer messages={[assistant(frames)]} />);
    // The failure waits for its turn instead of cutting in.
    expect(region()).toHaveTextContent('Creating web artifact');
    act(() => {
      jest.advanceTimersByTime(1600);
    });
    expect(region()).toHaveTextContent('Web artifact: Failed.');
  });

  test('says an identical text again when the region has to change to be read', () => {
    // Two files in a row get the same words: the second must not be swallowed.
    const first = [args(2, 'x1', T0)];
    const second = [args(2, 'x1', T0), args(3, 'x2', T0 + 700)];
    const { rerender } = render(<RunAnnouncer messages={[assistant(first)]} />);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(region()).toHaveTextContent('Creating web artifact');
    rerender(<RunAnnouncer messages={[assistant(second)]} />);
    act(() => {
      jest.advanceTimersByTime(700 + 1600);
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(region()).toHaveTextContent('Creating web artifact');
  });

  test('forgets what is waiting when the next turn begins', () => {
    const { rerender } = render(
      <RunAnnouncer messages={[assistant([grow(), argsEnded(3, 'x1', T0 + 700, 'truncated')])]} />
    );
    act(() => {
      jest.advanceTimersByTime(800);
    });
    // The next turn starts before the queue has been spoken.
    rerender(<RunAnnouncer messages={[user, assistant([], { id: 'm2', toolActivity: null })]} />);
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(region()).toBeEmptyDOMElement();
  });

  test('stops its timers when it goes away', () => {
    const { unmount } = render(<RunAnnouncer messages={[assistant([grow()])]} />);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── where it sits, and the loader ──────────────────────────────────────────

describe('ChatMessageList', () => {
  test('puts the announcer next to the log, not inside it', () => {
    render(<ChatMessageList messages={[user]} />);
    const log = screen.getByRole('log');
    expect(log).toContainElement(screen.getByText('Make a calculator'));
    expect(log).not.toContainElement(screen.getByRole('status'));
    // The region is there before the first turn has anything to say.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

describe('ChatMessage loader', () => {
  const dots = container => container.querySelectorAll('.animate-pulse');

  test('shows three dots while nothing else says the turn is busy, and they do not pulse under reduced motion', () => {
    const { container } = render(<ChatMessage message={assistant([])} outputFormat="markdown" />);
    expect(dots(container)).toHaveLength(3);
    for (const dot of dots(container)) expect(dot.className).toMatch(/motion-reduce:animate-none/);
  });

  test('stands down while the activity headline shows a spinner or a label', () => {
    const waiting = progress(2, 'model.waiting', {}, { elapsedMs: 3000 }, { receivedAt: T0 });
    const message = assistant([waiting]);
    const { container } = render(<ChatMessage message={message} outputFormat="markdown" />);
    expect(screen.getByText('Waiting for the model…')).toBeInTheDocument();
    expect(dots(container)).toHaveLength(0);
  });

  test('stays away while a file is being written, and returns when the answer streams', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      jest.advanceTimersByTime(T0);
      const writing = [args(2, 'x1', T0 - 600)];
      const { container, rerender } = render(
        <ChatMessage message={assistant(writing)} outputFormat="markdown" />
      );
      expect(screen.getByRole('button', { name: 'Creating web artifact…' })).toBeInTheDocument();
      expect(dots(container)).toHaveLength(0);
      // The file is done and the answer streams: the headline has no spinner now.
      const answering = [
        ...writing,
        argsEnded(3, 'x1', T0, 'ready'),
        toolStarted(4, 'x1'),
        toolCompleted(5, 'x1'),
        env(6, 'step/delta', { step: 1, kind: 'text', content: 'Here is the file.' })
      ];
      rerender(
        <ChatMessage
          message={assistant(answering, { content: 'Here is the file.' })}
          outputFormat="markdown"
        />
      );
      expect(dots(container)).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not hold the loader back while a call is still in its grace period', () => {
    const { container } = render(
      <ChatMessage
        message={assistant([args(2, 'x1', performance.now())])}
        outputFormat="markdown"
      />
    );
    // No row yet, no headline: the loader is all there is.
    expect(screen.queryByRole('button', { name: /Creating web artifact/ })).not.toBeInTheDocument();
    expect(dots(container)).toHaveLength(3);
  });
});
