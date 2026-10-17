/**
 * The voice mode hook (issue #2868): it wires the microphone session, the state
 * machine and the speech queue to the chat that is on screen. The session and
 * the queue are faked here (they have suites of their own); the reducer is real.
 */
import { act, renderHook } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) => (typeof defaultOrOptions === 'string' ? defaultOrOptions : key)
  })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({ debugLog: jest.fn() }));

const mockSession = {};
const mockQueue = {};
const mockHandlers = { onEvent: null, queue: null };
jest.mock('../../../client/src/features/voice/utils/voiceSession', () => ({
  createVoiceSession: jest.fn(async options => {
    mockHandlers.onEvent = options.onEvent;
    return mockSession;
  })
}));
jest.mock('../../../client/src/features/voice/utils/speechQueue', () => ({
  createSpeechQueue: jest.fn(options => {
    mockHandlers.queue = options;
    return mockQueue;
  })
}));

import useVoiceMode from '../../../client/src/features/voice/hooks/useVoiceMode';
import { createVoiceSession } from '../../../client/src/features/voice/utils/voiceSession';
import { createSpeechQueue } from '../../../client/src/features/voice/utils/speechQueue';

const availability = (settings = {}) => ({
  available: true,
  reason: null,
  settings: {
    listeningStyle: 'hands-free',
    bargeIn: true,
    endOfTurnSilenceMs: 800,
    maxSessionMinutes: 30,
    voice: '',
    ...settings
  },
  speech: { service: 'browser', modelId: '' },
  platformSpeech: { azure: { enabled: false } },
  ttsModelId: 'tts-model'
});

const USER = { id: 'u1', role: 'user', content: 'Hello there' };
const assistant = (extra = {}) => ({
  id: 'a1',
  role: 'assistant',
  content: '',
  loading: true,
  ...extra
});

/** The hook with props that a test changes the way the chat would. */
function setup(overrides = {}) {
  const calls = {
    sendTurn: jest.fn(async () => true),
    answerClarification: jest.fn(),
    cancelGeneration: jest.fn(),
    onEnded: jest.fn()
  };
  const props = {
    availability: availability(),
    language: 'en',
    messages: [],
    processing: false,
    clarificationPending: false,
    ...calls,
    ...overrides
  };
  props.sendTurn = overrides.sendTurn || calls.sendTurn;
  const hook = renderHook(() => useVoiceMode(props));
  const setProps = patch => {
    Object.assign(props, patch);
    hook.rerender();
  };
  return { ...hook, calls, props, setProps };
}

const emit = event => act(() => mockHandlers.onEvent(event));
const status = hook => hook.result.current.state.status;

async function startAndReady(hook) {
  await act(async () => {
    await hook.result.current.start();
  });
  emit({ type: 'ready' });
}

/** The user speaks and the transcript reaches the chat. */
async function speakTurn(transcript = 'Hello there') {
  emit({ type: 'speech-start' });
  emit({ type: 'turn-end' });
  await act(async () => {
    mockHandlers.onEvent({ type: 'final', text: transcript });
  });
}

beforeEach(() => {
  Object.assign(mockSession, {
    setAgentState: jest.fn(),
    setMuted: jest.fn(),
    setListeningStyle: jest.fn(),
    setBargeIn: jest.fn(),
    pushToTalkStart: jest.fn(),
    pushToTalkEnd: jest.fn(),
    stop: jest.fn()
  });
  Object.assign(mockQueue, {
    update: jest.fn(),
    say: jest.fn(),
    interrupt: jest.fn(),
    isSpeaking: jest.fn(() => false),
    dispose: jest.fn()
  });
  mockHandlers.onEvent = null;
  mockHandlers.queue = null;
  createVoiceSession.mockClear();
  createSpeechQueue.mockClear();
  window.localStorage.clear();
});

describe('starting', () => {
  test('creates the speech queue and the session from the click, with the app’s settings', async () => {
    const hook = setup({
      availability: availability({ voice: 'marie', endOfTurnSilenceMs: 600, bargeIn: false })
    });
    expect(hook.result.current.active).toBe(false);
    await act(async () => {
      await hook.result.current.start();
    });

    expect(hook.result.current.active).toBe(true);
    expect(status(hook)).toBe('connecting');
    expect(createSpeechQueue).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'tts-model', language: 'en', voice: 'marie' })
    );
    expect(createVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'browser',
        language: 'en',
        listeningStyle: 'hands-free',
        bargeIn: false,
        endOfTurnSilenceMs: 600,
        speech: { azure: { enabled: false } }
      })
    );
    emit({ type: 'ready' });
    expect(status(hook)).toBe('listening');
  });

  test('does nothing when voice mode is not available', async () => {
    const hook = setup({ availability: { ...availability(), available: false } });
    await act(async () => {
      await hook.result.current.start();
    });
    expect(createSpeechQueue).not.toHaveBeenCalled();
    expect(hook.result.current.active).toBe(false);
  });

  test('a second start while one is open does not open another session', async () => {
    const hook = setup();
    await startAndReady(hook);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(createVoiceSession).toHaveBeenCalledTimes(1);
  });

  test('a blocked microphone ends in an error that can be retried', async () => {
    createVoiceSession.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    );
    const hook = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(status(hook)).toBe('error');
    expect(hook.result.current.state.error.code).toBe('mic-denied');
    expect(mockQueue.dispose).toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.retry();
    });
    expect(createVoiceSession).toHaveBeenCalledTimes(2);
    expect(status(hook)).toBe('connecting');
  });

  test('without Web Audio the start fails cleanly', async () => {
    createSpeechQueue.mockImplementationOnce(() => {
      throw new Error('Audio playback is not supported in this browser');
    });
    const hook = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(status(hook)).toBe('error');
    expect(hook.result.current.state.error.code).toBe('audio-unsupported');
    expect(createVoiceSession).not.toHaveBeenCalled();
  });

  test('an unrecoverable session error stops the microphone and shows the error', async () => {
    const hook = setup();
    await startAndReady(hook);
    emit({ type: 'error', code: 'mic-lost', message: 'gone', recoverable: false });
    expect(status(hook)).toBe('error');
    expect(mockSession.stop).toHaveBeenCalled();
    expect(mockQueue.interrupt).toHaveBeenCalled();
  });
});

describe('a spoken turn', () => {
  test('goes from speech through the chat to a spoken answer and back to listening', async () => {
    const hook = setup();
    await startAndReady(hook);

    emit({ type: 'speech-start' });
    expect(status(hook)).toBe('user-speaking');
    emit({ type: 'interim', text: 'Hello' });
    expect(hook.result.current.state.userCaption).toEqual({ text: 'Hello', final: false });
    emit({ type: 'turn-end' });
    expect(status(hook)).toBe('thinking');

    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: ' Hello there ' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Hello there');
    expect(hook.result.current.state.userCaption).toEqual({ text: 'Hello there', final: true });
    expect(hook.result.current.state.runActive).toBe(true);
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('thinking');

    // The chat adds the question and an answer that is being written.
    hook.setProps({
      messages: [USER, assistant({ content: 'Hi. How are' })],
      processing: true
    });
    expect(mockQueue.update).toHaveBeenLastCalledWith('Hi. How are', { final: false });
    expect(hook.result.current.state.assistantCaption).toBe('Hi. How are');

    // The answer is complete: the rest is flushed, and the first audio plays.
    hook.setProps({
      messages: [USER, assistant({ content: 'Hi. How are you?', loading: false })],
      processing: false
    });
    expect(mockQueue.update).toHaveBeenLastCalledWith('Hi. How are you?', { final: true });
    expect(hook.result.current.state.runActive).toBe(false);

    act(() => mockHandlers.queue.onSpeakingStart());
    expect(status(hook)).toBe('speaking');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('speaking');
    act(() => mockHandlers.queue.onDrained());
    expect(status(hook)).toBe('listening');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');
  });

  test('an answer with nothing to speak returns to listening at once', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: '| a | b |', loading: false })],
      processing: false
    });
    expect(status(hook)).toBe('listening');
  });

  test('while the queue still has audio to come, the run ending does not claim listening', async () => {
    mockQueue.isSpeaking.mockReturnValue(true);
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: 'Sure.', loading: false })],
      processing: false
    });
    expect(status(hook)).toBe('thinking');
  });

  test('citation markers are not read out', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [
        USER,
        assistant({ content: 'Revenue grew [1](https://a.example/x) a lot.', loading: true })
      ],
      processing: true
    });
    expect(mockQueue.update).toHaveBeenLastCalledWith('Revenue grew a lot.', { final: false });
  });

  test('the speech queue is not fed again once the answer is complete', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: 'Done.', loading: false })],
      processing: false
    });
    mockQueue.update.mockClear();
    // Something re-renders the message afterwards (a source list, an edit).
    hook.setProps({
      messages: [USER, assistant({ content: 'Done. Extra.', loading: false })],
      processing: false
    });
    expect(mockQueue.update).not.toHaveBeenCalled();
  });

  test('the tool the app is running shows while it thinks, and clears', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [
        USER,
        assistant({
          toolActivity: { items: [{ kind: 'search', scope: 'web', status: 'running' }] }
        })
      ],
      processing: true
    });
    expect(hook.result.current.state.toolStatus).toEqual({
      kind: 'search',
      label: 'Searching the web…'
    });
    hook.setProps({
      messages: [
        USER,
        assistant({
          content: 'Found it.',
          toolActivity: { items: [{ kind: 'search', scope: 'web', status: 'completed' }] }
        })
      ]
    });
    expect(hook.result.current.state.toolStatus).toBeNull();
  });

  test('marks nothing the chat did not accept: a turn the chat turns away is not waited for', async () => {
    const sendTurn = jest.fn(async () => false);
    const hook = setup({ sendTurn });
    await startAndReady(hook);
    await speakTurn();
    expect(hook.result.current.state.runActive).toBe(false);
    expect(status(hook)).toBe('listening');
    expect(mockQueue.say).toHaveBeenCalledWith('I could not send that. Please try again.');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');
  });
});

describe('transcripts that are not turns', () => {
  test('a cough or a filler word is dropped without sending anything', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn('uh');
    expect(hook.calls.sendTurn).not.toHaveBeenCalled();
    expect(status(hook)).toBe('listening');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');
  });

  test('a transcript that arrives while the app speaks, with interrupting off, is not sent', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: 'Sure thing.', loading: false })],
      processing: false
    });
    act(() => mockHandlers.queue.onSpeakingStart());
    expect(status(hook)).toBe('speaking');
    hook.calls.sendTurn.mockClear();

    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'something the speakers leaked' });
    });
    expect(hook.calls.sendTurn).not.toHaveBeenCalled();
    expect(status(hook)).toBe('speaking');
  });
});

describe('interrupting', () => {
  async function speaking(hook) {
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: 'A long answer. It goes on.', loading: true })],
      processing: true
    });
    act(() => mockHandlers.queue.onSpeakingStart());
  }

  test('speaking over the app stops the audio and the run, and listens', async () => {
    const hook = setup();
    await speaking(hook);
    expect(status(hook)).toBe('speaking');

    emit({ type: 'barge-in' });
    expect(mockQueue.interrupt).toHaveBeenCalled();
    expect(hook.calls.cancelGeneration).toHaveBeenCalledWith('voice-barge-in');
    expect(status(hook)).toBe('user-speaking');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');
    expect(hook.result.current.state.assistantCaption).toBe('');
  });

  test('the aborted run is not spoken any further', async () => {
    const hook = setup();
    await speaking(hook);
    emit({ type: 'barge-in' });
    mockQueue.update.mockClear();
    hook.setProps({
      messages: [USER, assistant({ content: 'A long answer. It goes on. And on.', loading: true })],
      processing: true
    });
    expect(mockQueue.update).not.toHaveBeenCalled();
  });

  test('speaking while the app is still thinking interrupts too', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, assistant()], processing: true });
    expect(status(hook)).toBe('thinking');

    emit({ type: 'speech-start' });
    expect(hook.calls.cancelGeneration).toHaveBeenCalledWith('voice-barge-in');
    expect(status(hook)).toBe('user-speaking');
  });

  test('with interrupting off, speech while the app speaks changes nothing', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await speaking(hook);
    emit({ type: 'speech-start' });
    expect(status(hook)).toBe('speaking');
    expect(hook.calls.cancelGeneration).not.toHaveBeenCalled();
  });

  test('a tap on the orb stops the answer even with interrupting off', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await speaking(hook);
    act(() => hook.result.current.interrupt());
    expect(mockQueue.interrupt).toHaveBeenCalled();
  });
});

describe('ending', () => {
  test('closes the microphone and the audio but leaves the turn running', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, assistant({ content: 'Still writing' })], processing: true });

    act(() => hook.result.current.end('user'));
    expect(hook.result.current.active).toBe(false);
    expect(mockSession.stop).toHaveBeenCalled();
    expect(mockQueue.dispose).toHaveBeenCalled();
    expect(hook.calls.cancelGeneration).not.toHaveBeenCalled();
    expect(hook.calls.onEnded).toHaveBeenCalledWith('user');
  });

  test('a session that runs out of time ends by itself', async () => {
    jest.useFakeTimers();
    const hook = setup({ availability: availability({ maxSessionMinutes: 2 }) });
    await startAndReady(hook);
    act(() => jest.advanceTimersByTime(2 * 60_000 + 10));
    expect(hook.result.current.active).toBe(false);
    expect(hook.calls.onEnded).toHaveBeenCalledWith('time-limit');
    jest.useRealTimers();
  });

  test('events from a session that was ended are ignored', async () => {
    const hook = setup();
    await startAndReady(hook);
    const staleHandler = mockHandlers.onEvent;
    act(() => hook.result.current.end('user'));
    await act(async () => {
      staleHandler({ type: 'final', text: 'too late' });
    });
    expect(hook.calls.sendTurn).not.toHaveBeenCalled();
  });

  test('a tab that goes to the background mutes the microphone', async () => {
    const hook = setup();
    await startAndReady(hook);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mockSession.setMuted).toHaveBeenCalledWith(true);
    expect(status(hook)).toBe('paused');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
});

describe('a question the app asks', () => {
  const asking = (extra = {}) =>
    assistant({
      content: 'I need one thing.',
      loading: false,
      awaitingInput: true,
      clarification: {
        questionId: 'q1',
        question: 'Which size?',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'large', label: 'Large' }
        ]
      },
      ...extra
    });

  test('is spoken, and the next utterance answers it', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, asking()], processing: false, clarificationPending: true });
    expect(mockQueue.say).toHaveBeenCalledWith('Which size?');

    hook.calls.sendTurn.mockClear();
    await speakTurn('The large one, please');
    expect(hook.calls.sendTurn).not.toHaveBeenCalled();
    expect(hook.calls.answerClarification).toHaveBeenCalledWith({
      questionId: 'q1',
      answered: true,
      skipped: false,
      value: 'large',
      displayText: 'Large'
    });
  });

  test('is spoken once, however often the chat re-renders', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, asking()], processing: false, clarificationPending: true });
    hook.setProps({ messages: [USER, asking()], processing: false, clarificationPending: true });
    expect(mockQueue.say).toHaveBeenCalledTimes(1);
  });
});

describe('settings', () => {
  test('the listening style and interrupting are kept for the user and reach the session', async () => {
    const hook = setup();
    await startAndReady(hook);

    act(() => hook.result.current.setListeningStyle('push-to-talk'));
    expect(mockSession.setListeningStyle).toHaveBeenCalledWith('push-to-talk');
    expect(hook.result.current.state.listeningStyle).toBe('push-to-talk');
    act(() => hook.result.current.setBargeIn(false));
    expect(mockSession.setBargeIn).toHaveBeenCalledWith(false);
    expect(hook.result.current.state.bargeIn).toBe(false);
    act(() => hook.result.current.setCaptions(false));
    expect(hook.result.current.state.captions).toBe(false);

    expect(JSON.parse(window.localStorage.getItem('ihub.voiceMode.prefs'))).toEqual({
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      captions: false
    });

    // A later session starts from the user's choices, not the platform's.
    const next = setup();
    expect(next.result.current.prefs).toEqual({
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      captions: false
    });
  });

  test('muting stops the audio and tells the session', async () => {
    const hook = setup();
    await startAndReady(hook);
    act(() => hook.result.current.setMuted(true));
    expect(mockSession.setMuted).toHaveBeenCalledWith(true);
    expect(mockQueue.interrupt).toHaveBeenCalled();
    expect(status(hook)).toBe('paused');
    act(() => hook.result.current.setMuted(false));
    expect(status(hook)).toBe('listening');
  });

  test('push-to-talk is passed through to the session', async () => {
    const hook = setup();
    await startAndReady(hook);
    act(() => hook.result.current.pushToTalkStart());
    act(() => hook.result.current.pushToTalkEnd());
    expect(mockSession.pushToTalkStart).toHaveBeenCalled();
    expect(mockSession.pushToTalkEnd).toHaveBeenCalled();
  });
});
