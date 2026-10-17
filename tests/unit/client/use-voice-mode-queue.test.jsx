/**
 * Voice mode (issue #2868): the hook together with the REAL speech queue.
 *
 * `use-voice-mode.test.jsx` fakes the queue, which is right for the hook's own
 * logic but cannot show one thing that matters: after `queue.interrupt()` the
 * queue forgets what it has already said (its chunker restarts), so a hook that
 * went on feeding it the growing answer text would make it speak the answer
 * again from the first sentence. Here the queue is real; only Web Audio and the
 * network are fakes, and the speech requests that go out are what is checked.
 */
import { act, renderHook } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) => (typeof defaultOrOptions === 'string' ? defaultOrOptions : key)
  })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({ debugLog: jest.fn() }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));

const mockFetch = jest.fn();
jest.mock('../../../client/src/shared/utils/openSseStream', () => ({
  fetchWithAuthRetry: (...args) => mockFetch(...args)
}));

const mockSession = {};
const mockHandlers = { onEvent: null };
jest.mock('../../../client/src/features/voice/utils/voiceSession', () => ({
  createVoiceSession: jest.fn(async options => {
    mockHandlers.onEvent = options.onEvent;
    return mockSession;
  })
}));

import useVoiceMode from '../../../client/src/features/voice/hooks/useVoiceMode';

class FakeSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.onended = null;
  }
  connect() {}
  start(when) {
    this.startAt = when;
    this.ctx.started.push(this);
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.started = [];
    this.resume = jest.fn(() => Promise.resolve());
  }
  createBuffer(channels, length, sampleRate) {
    return { length, sampleRate, duration: length / sampleRate, copyToChannel() {} };
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const USER = { id: 'u1', role: 'user', content: 'Hello there' };
const assistant = (content, extra = {}) => ({
  id: 'a1',
  role: 'assistant',
  content,
  loading: true,
  ...extra
});

const availability = {
  available: true,
  reason: null,
  settings: {
    listeningStyle: 'hands-free',
    bargeIn: true,
    endOfTurnSilenceMs: 800,
    maxSessionMinutes: 30,
    voice: ''
  },
  speech: { service: 'browser', modelId: '' },
  platformSpeech: { azure: { enabled: false } },
  ttsModelId: 'tts-model'
};

/** The texts the queue asked the speech endpoint to read, in order. */
let requested;

function setup() {
  const props = {
    availability,
    language: 'en',
    messages: [],
    processing: false,
    clarificationPending: false,
    sendTurn: jest.fn(async () => true),
    answerClarification: jest.fn(),
    cancelGeneration: jest.fn(),
    onEnded: jest.fn()
  };
  const hook = renderHook(() => useVoiceMode(props));
  const setProps = patch => {
    Object.assign(props, patch);
    hook.rerender();
  };
  return { ...hook, props, setProps };
}

const emit = event => act(() => mockHandlers.onEvent(event));

async function streamingAnswer(hook, content) {
  await act(async () => {
    await hook.result.current.start();
  });
  emit({ type: 'ready' });
  emit({ type: 'speech-start' });
  emit({ type: 'turn-end' });
  await act(async () => {
    mockHandlers.onEvent({ type: 'final', text: 'Hello there' });
  });
  hook.setProps({ messages: [USER, assistant(content)], processing: true });
}

beforeEach(() => {
  window.AudioContext = FakeAudioContext;
  requested = [];
  mockFetch.mockReset();
  // A request that never answers: the test is about which requests are made.
  mockFetch.mockImplementation((url, init) => {
    requested.push(JSON.parse(init.body).text);
    return new Promise(() => {});
  });
  Object.assign(mockSession, {
    setAgentState: jest.fn(),
    setMuted: jest.fn(),
    setListeningStyle: jest.fn(),
    setBargeIn: jest.fn(),
    pushToTalkStart: jest.fn(),
    pushToTalkEnd: jest.fn(),
    stop: jest.fn()
  });
  window.localStorage.clear();
});

describe('the hook with the real speech queue', () => {
  const first = 'First sentence is here. Second sentence is here. Thi';

  test('control: the answer is read once, sentence by sentence, as it streams', async () => {
    const hook = setup();
    await streamingAnswer(hook, first);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested[0]).toMatch(/^First sentence is here/);
    expect(requested.filter(text => text.startsWith('First sentence'))).toHaveLength(1);
  });

  test('muting while the answer streams does not make it start over', async () => {
    const hook = setup();
    await streamingAnswer(hook, first);
    const before = requested.length;
    expect(before).toBeGreaterThan(0);

    act(() => hook.result.current.setMuted(true));
    hook.setProps({
      messages: [
        USER,
        assistant('First sentence is here. Second sentence is here. Third sentence is here. Fou')
      ]
    });
    hook.setProps({
      messages: [
        USER,
        assistant(
          'First sentence is here. Second sentence is here. Third sentence is here. Fourth one.',
          { loading: false }
        )
      ],
      processing: false
    });

    // Not one more speech request: neither the old sentences again nor the new
    // ones (the user muted the audio).
    expect(requested).toHaveLength(before);
    expect(hook.result.current.state.runActive).toBe(false);
  });

  test('a session that fails mid-answer does not make it start over either', async () => {
    const hook = setup();
    await streamingAnswer(hook, first);
    const before = requested.length;

    emit({ type: 'error', code: 'connection', message: 'lost', recoverable: false });
    hook.setProps({
      messages: [
        USER,
        assistant('First sentence is here. Second sentence is here. Third sentence is here. Fou')
      ]
    });
    expect(requested).toHaveLength(before);
  });
});
