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

import { debugLog } from '../../../client/src/utils/debugLog';
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

  test('a send that throws ends the turn the same way, instead of leaving the app thinking', async () => {
    const sendTurn = jest.fn(async () => {
      throw new Error('network down');
    });
    const hook = setup({ sendTurn });
    await startAndReady(hook);
    await speakTurn();
    expect(hook.result.current.state.runActive).toBe(false);
    expect(status(hook)).toBe('listening');
    expect(mockQueue.say).toHaveBeenCalledWith('I could not send that. Please try again.');
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

  test('a tap on the orb stops the answer even with interrupting off, and the app listens', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await speaking(hook);
    expect(status(hook)).toBe('speaking');
    act(() => hook.result.current.interrupt());
    expect(mockQueue.interrupt).toHaveBeenCalled();
    expect(hook.calls.cancelGeneration).toHaveBeenCalledWith('voice-barge-in');
    // Not stuck in "speaking" with the audio gone: nobody speaks yet, so it listens.
    expect(status(hook)).toBe('listening');
    expect(hook.result.current.state.runActive).toBe(false);
    expect(hook.result.current.state.assistantCaption).toBe('');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');
  });

  test('a tap on the orb while the app is still thinking stops the run too, interrupting off', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, assistant()], processing: true });
    expect(status(hook)).toBe('thinking');
    act(() => hook.result.current.interrupt());
    expect(hook.calls.cancelGeneration).toHaveBeenCalledWith('voice-barge-in');
    expect(status(hook)).toBe('listening');
    expect(hook.result.current.state.runActive).toBe(false);

    // The next thing the user says is a turn of its own.
    hook.calls.sendTurn.mockClear();
    await speakTurn('Never mind, something else');
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Never mind, something else');
  });

  test('the click event of the orb is not mistaken for a forced interruption by the session', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await speaking(hook);
    // What the overlay does: `onClick={voiceMode.interrupt}` hands over the event.
    act(() => hook.result.current.interrupt({ type: 'click', force: false }));
    expect(status(hook)).toBe('listening');
  });

  test('speaking while the app answers is still ignored with interrupting off (only the tap forces)', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await speaking(hook);
    mockQueue.interrupt.mockClear();
    emit({ type: 'barge-in' });
    expect(status(hook)).toBe('speaking');
    // Nothing is stopped behind the state machine's back either.
    expect(mockQueue.interrupt).not.toHaveBeenCalled();
    expect(hook.calls.cancelGeneration).not.toHaveBeenCalled();
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

  test('words that name none of the options are not an answer: asked again, question still pending', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, asking()], processing: false, clarificationPending: true });
    hook.calls.sendTurn.mockClear();
    mockQueue.say.mockClear();

    await speakTurn('I do not know yet');
    // Nothing reaches the model, neither as an answer nor as a new message.
    expect(hook.calls.answerClarification).not.toHaveBeenCalled();
    expect(hook.calls.sendTurn).not.toHaveBeenCalled();
    expect(mockQueue.say).toHaveBeenCalledWith(
      'I did not catch which option you meant. Please say it again.'
    );
    // The turn is over like one the chat turned away: listening, agent idle.
    expect(status(hook)).toBe('listening');
    expect(hook.result.current.state.runActive).toBe(false);
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');

    // The question is still there to be answered.
    await speakTurn('The small one');
    expect(hook.calls.answerClarification).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'q1', value: 'small', displayText: 'Small' })
    );
  });

  test('a question that allows another answer takes the unclear words as the answer', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [
        USER,
        asking({
          clarification: {
            questionId: 'q1',
            question: 'Which size?',
            allowOther: true,
            options: [{ value: 'small', label: 'Small' }]
          }
        })
      ],
      processing: false,
      clarificationPending: true
    });
    await speakTurn('something in between');
    expect(hook.calls.answerClarification).toHaveBeenCalledWith({
      questionId: 'q1',
      answered: true,
      skipped: false,
      value: 'something in between',
      displayText: 'something in between'
    });
    expect(mockQueue.say).not.toHaveBeenCalledWith(expect.stringContaining('did not catch'));
  });

  test('is not spoken before the session is up (the audio would play while the state ignores it)', async () => {
    const hook = setup({
      messages: [USER, asking()],
      clarificationPending: true
    });
    await act(async () => {
      await hook.result.current.start();
    });
    expect(status(hook)).toBe('connecting');
    expect(mockQueue.say).not.toHaveBeenCalled();

    emit({ type: 'ready' });
    expect(mockQueue.say).toHaveBeenCalledWith('Which size?');
    expect(mockQueue.say).toHaveBeenCalledTimes(1);
    // The audio starts in a state that takes it: the orb shows the app speaking.
    act(() => mockHandlers.queue.onSpeakingStart());
    expect(status(hook)).toBe('speaking');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('speaking');
  });

  test('is not spoken again when the user talks over it and the chat re-renders', async () => {
    const hook = setup({ messages: [USER, asking()], clarificationPending: true });
    await startAndReady(hook);
    expect(mockQueue.say).toHaveBeenCalledTimes(1);
    act(() => mockHandlers.queue.onSpeakingStart());
    emit({ type: 'barge-in' });
    hook.setProps({ messages: [USER, asking()] });
    hook.setProps({ messages: [USER, asking({ content: 'I need one thing, really.' })] });
    expect(mockQueue.say).toHaveBeenCalledTimes(1);
  });

  test('is not spoken again after a turn that was understood or not', async () => {
    const hook = setup({ messages: [USER, asking()], clarificationPending: true });
    await startAndReady(hook);
    await speakTurn('not sure');
    hook.setProps({ messages: [USER, asking()] });
    const questionSpoken = mockQueue.say.mock.calls.filter(([said]) => said === 'Which size?');
    expect(questionSpoken).toHaveLength(1);
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

describe('sound while the app works on the answer, interrupting off', () => {
  async function thinkingWithRun(hook) {
    await startAndReady(hook);
    await speakTurn('Hello there');
    hook.setProps({ messages: [USER, assistant({ content: 'Partial.' })], processing: true });
    expect(status(hook)).toBe('thinking');
  }

  test('a turn end of no turn of ours does not lose the answer that is on its way', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await thinkingWithRun(hook);

    // Something passes the detector while the app thinks: the state machine
    // ignores the speech start, the turn end and the transcript.
    emit({ type: 'speech-start' });
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'and another thing' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledTimes(1);
    expect(status(hook)).toBe('thinking');
    expect(hook.result.current.state.runActive).toBe(true);

    // The answer is still read out, to the end.
    hook.setProps({
      messages: [USER, assistant({ content: 'Partial. Complete answer.', loading: false })],
      processing: false
    });
    expect(mockQueue.update).toHaveBeenLastCalledWith('Partial. Complete answer.', {
      final: true
    });
    expect(hook.result.current.state.runActive).toBe(false);
    expect(status(hook)).toBe('listening');
  });

  test('an empty transcript during the run does not tell the session the app is idle', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await thinkingWithRun(hook);
    emit({ type: 'speech-start' });
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: '' });
    });
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('thinking');
    expect(status(hook)).toBe('thinking');
  });

  test('the app counts as busy from the turn end on, so the next sound starts no turn', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await startAndReady(hook);
    emit({ type: 'speech-start' });
    mockSession.setAgentState.mockClear();
    emit({ type: 'turn-end' });
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('thinking');
    // A transcript without words ends it.
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: '' });
    });
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');
    expect(status(hook)).toBe('listening');
  });

  test('when the audio catches up with an answer that is still being written the app stays busy', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({ messages: [USER, assistant({ content: 'One. Two' })], processing: true });
    act(() => mockHandlers.queue.onSpeakingStart());
    act(() => mockHandlers.queue.onDrained());
    expect(status(hook)).toBe('thinking');
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('thinking');
  });
});

describe('speech that resumes while the transcript of the first part is on its way', () => {
  /** The user paused, the silence ended turn 1, and they went on. */
  function pausedAndResumed() {
    emit({ type: 'speech-start' });
    emit({ type: 'turn-end' });
    emit({ type: 'speech-start' });
  }

  test('the first part is not sent as a turn: one send with both parts, in order', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    expect(status(hook)).toBe('user-speaking');

    // The transcript of the first part comes back while the user talks.
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Please tell me about' });
    });
    expect(hook.calls.sendTurn).not.toHaveBeenCalled();
    expect(status(hook)).toBe('user-speaking');
    expect(hook.result.current.state.userCaption).toEqual({
      text: 'Please tell me about',
      final: false
    });

    // The caption goes on with the whole sentence.
    emit({ type: 'interim', text: 'the weather' });
    expect(hook.result.current.state.userCaption.text).toBe('Please tell me about the weather');

    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'the weather in Berlin' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledTimes(1);
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Please tell me about the weather in Berlin');
    expect(hook.result.current.state.userCaption).toEqual({
      text: 'Please tell me about the weather in Berlin',
      final: true
    });

    // The answer is spoken and the app returns to listening.
    hook.setProps({
      messages: [USER, assistant({ content: 'Sunny.', loading: false })],
      processing: false
    });
    expect(mockQueue.update).toHaveBeenLastCalledWith('Sunny.', { final: true });
    act(() => mockHandlers.queue.onSpeakingStart());
    act(() => mockHandlers.queue.onDrained());
    expect(status(hook)).toBe('listening');
  });

  test('the first part goes out alone when what follows is empty (a cough)', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Please tell me about Berlin' });
    });
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: '' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledTimes(1);
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Please tell me about Berlin');
  });

  test('a first part that is only a filler word does not start a turn, nor does it stay in the way', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'uh' });
    });
    expect(status(hook)).toBe('user-speaking');
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'What time is it' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('uh What time is it');
  });

  test('an empty first part changes nothing', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: '' });
    });
    expect(status(hook)).toBe('user-speaking');
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'What time is it' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('What time is it');
  });

  test('the first part is used once: the turn after it starts clean', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'First half' });
    });
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'second half' });
    });
    hook.setProps({
      messages: [USER, assistant({ content: 'Done.', loading: false })],
      processing: false
    });
    hook.calls.sendTurn.mockClear();
    await speakTurn('A new question');
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('A new question');
  });

  test('muting forgets it: what is said after the unmute is not glued to it', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Please tell me about' });
    });
    act(() => hook.result.current.setMuted(true));
    act(() => hook.result.current.setMuted(false));
    await speakTurn('Something else');
    expect(hook.calls.sendTurn).toHaveBeenCalledTimes(1);
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Something else');
  });

  test('a new session forgets it', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Please tell me about' });
    });
    emit({ type: 'error', code: 'connection', message: '', recoverable: false });
    await act(async () => {
      await hook.result.current.retry();
    });
    emit({ type: 'ready' });
    await speakTurn('Hello again');
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Hello again');
  });

  test('ending voice mode forgets it', async () => {
    const hook = setup();
    await startAndReady(hook);
    pausedAndResumed();
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Please tell me about' });
    });
    act(() => hook.result.current.end('user'));
    await startAndReady(hook);
    await speakTurn('Hello again');
    expect(hook.calls.sendTurn).toHaveBeenCalledWith('Hello again');
  });

  test('with interrupting off a resumed sentence is not part of a pending turn: the transcript is sent once', async () => {
    const hook = setup({ availability: availability({ bargeIn: false }) });
    await startAndReady(hook);
    pausedAndResumed();
    // The state machine does not move to user-speaking for sound while it waits.
    expect(status(hook)).toBe('thinking');
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Please tell me about' });
    });
    expect(hook.calls.sendTurn).toHaveBeenCalledTimes(1);
    // The turn end of the second burst does not lose the run.
    emit({ type: 'turn-end' });
    hook.setProps({
      messages: [USER, assistant({ content: 'Sure.', loading: false })],
      processing: false
    });
    expect(mockQueue.update).toHaveBeenLastCalledWith('Sure.', { final: true });
    expect(status(hook)).toBe('listening');
  });
});

describe('muting while the answer is still being written', () => {
  const streamingAnswer = async hook => {
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: 'First sentence here. Second sentence here.' })],
      processing: true
    });
    act(() => mockHandlers.queue.onSpeakingStart());
  };

  test('the audio stays silent: the speech queue is not fed the text it forgot', async () => {
    const hook = setup();
    await streamingAnswer(hook);
    expect(mockQueue.update).toHaveBeenCalledWith('First sentence here. Second sentence here.', {
      final: false
    });

    mockQueue.update.mockClear();
    act(() => hook.result.current.setMuted(true));
    expect(mockQueue.interrupt).toHaveBeenCalledTimes(1);
    expect(mockSession.setAgentState).toHaveBeenLastCalledWith('idle');

    // More of the answer arrives. The queue forgot the first sentences when it
    // was interrupted, so feeding it the whole text would read them again.
    hook.setProps({
      messages: [
        USER,
        assistant({ content: 'First sentence here. Second sentence here. Third one.' })
      ],
      processing: true
    });
    expect(mockQueue.update).not.toHaveBeenCalled();
    // The caption still follows the answer.
    expect(hook.result.current.state.assistantCaption).toBe(
      'First sentence here. Second sentence here. Third one.'
    );
  });

  test('the run ends cleanly: no audio at the end, no question read out, back to listening after the unmute', async () => {
    const hook = setup();
    await streamingAnswer(hook);
    act(() => hook.result.current.setMuted(true));
    mockQueue.update.mockClear();

    hook.setProps({
      messages: [
        USER,
        assistant({
          content: 'First sentence here. Second sentence here. Which size?',
          loading: false,
          awaitingInput: true,
          clarification: { questionId: 'q9', question: 'Which size?', options: [] }
        })
      ],
      processing: false,
      clarificationPending: true
    });
    expect(mockQueue.update).not.toHaveBeenCalled();
    expect(mockQueue.say).not.toHaveBeenCalled();
    expect(hook.result.current.state.runActive).toBe(false);
    expect(status(hook)).toBe('paused');

    act(() => hook.result.current.setMuted(false));
    expect(status(hook)).toBe('listening');
  });

  test('unmuting while the run goes on waits for it instead of claiming to listen', async () => {
    const hook = setup();
    await streamingAnswer(hook);
    act(() => hook.result.current.setMuted(true));
    act(() => hook.result.current.setMuted(false));
    expect(status(hook)).toBe('thinking');
    expect(hook.result.current.state.runActive).toBe(true);
    hook.setProps({
      messages: [USER, assistant({ content: 'First sentence here. Done.', loading: false })],
      processing: false
    });
    expect(status(hook)).toBe('listening');
  });

  test('the next turn after the unmute is spoken again', async () => {
    const hook = setup();
    await streamingAnswer(hook);
    act(() => hook.result.current.setMuted(true));
    hook.setProps({
      messages: [USER, assistant({ content: 'First sentence here. Done.', loading: false })],
      processing: false
    });
    act(() => hook.result.current.setMuted(false));

    const finished = [USER, assistant({ content: 'First sentence here. Done.', loading: false })];
    hook.setProps({ messages: finished });
    await speakTurn('And one more thing');
    mockQueue.update.mockClear();
    hook.setProps({
      messages: [
        ...finished,
        { id: 'u2', role: 'user', content: 'And one more thing' },
        assistant({ id: 'a2', content: 'Gladly.' })
      ],
      processing: true
    });
    expect(mockQueue.update).toHaveBeenCalledWith('Gladly.', { final: false });
  });

  test('a session that fails mid-answer leaves the audio silent too', async () => {
    const hook = setup();
    await streamingAnswer(hook);
    mockQueue.update.mockClear();
    emit({ type: 'error', code: 'connection', message: 'lost', recoverable: false });
    expect(status(hook)).toBe('error');
    expect(mockQueue.interrupt).toHaveBeenCalled();
    expect(mockSession.setAgentState).toHaveBeenCalledWith('idle');

    hook.setProps({
      messages: [
        USER,
        assistant({ content: 'First sentence here. Second sentence here. Third one.' })
      ],
      processing: true
    });
    expect(mockQueue.update).not.toHaveBeenCalled();
    hook.setProps({
      messages: [USER, assistant({ content: 'First. Second. Third.', loading: false })],
      processing: false
    });
    expect(mockQueue.update).not.toHaveBeenCalled();
  });
});

describe('a muted session', () => {
  test('mute, error and retry: the new session is not muted, and the state says so', async () => {
    const hook = setup();
    await startAndReady(hook);
    act(() => hook.result.current.setMuted(true));
    emit({ type: 'error', code: 'connection', message: '', recoverable: false });
    mockSession.setMuted.mockClear();

    await act(async () => {
      await hook.result.current.retry();
    });
    expect(hook.result.current.state.muted).toBe(false);
    expect(mockSession.setMuted).not.toHaveBeenCalled();
    emit({ type: 'ready' });
    expect(status(hook)).toBe('listening');
  });

  test('muting while the session is still being created reaches the session', async () => {
    let release;
    createVoiceSession.mockImplementationOnce(
      options =>
        new Promise(resolve => {
          mockHandlers.onEvent = options.onEvent;
          release = () => resolve(mockSession);
        })
    );
    const hook = setup();
    let started;
    await act(async () => {
      started = hook.result.current.start();
    });
    act(() => hook.result.current.setMuted(true));
    expect(status(hook)).toBe('connecting');
    expect(mockSession.setMuted).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await started;
    });
    expect(mockSession.setMuted).toHaveBeenCalledWith(true);
    emit({ type: 'ready' });
    expect(status(hook)).toBe('paused');
  });
});

describe('settings changed while the session is being created', () => {
  test('the listening style and interrupting the user picked reach the session', async () => {
    let release;
    createVoiceSession.mockImplementationOnce(
      options =>
        new Promise(resolve => {
          mockHandlers.onEvent = options.onEvent;
          release = () => resolve(mockSession);
        })
    );
    const hook = setup();
    let started;
    await act(async () => {
      started = hook.result.current.start();
    });
    // The permission prompt is open; the user opens the settings.
    act(() => hook.result.current.setListeningStyle('push-to-talk'));
    act(() => hook.result.current.setBargeIn(false));
    expect(mockSession.setListeningStyle).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await started;
    });
    expect(createVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({ listeningStyle: 'hands-free', bargeIn: true })
    );
    expect(mockSession.setListeningStyle).toHaveBeenCalledWith('push-to-talk');
    expect(mockSession.setBargeIn).toHaveBeenCalledWith(false);
  });

  test('settings that did not change are not sent again', async () => {
    const hook = setup();
    await startAndReady(hook);
    expect(mockSession.setListeningStyle).not.toHaveBeenCalled();
    expect(mockSession.setBargeIn).not.toHaveBeenCalled();
    expect(mockSession.setMuted).not.toHaveBeenCalled();
  });
});

describe('when the answer cannot be spoken', () => {
  test('the user is told: a notice in the state, once per answer', async () => {
    const hook = setup();
    await startAndReady(hook);
    await speakTurn();
    hook.setProps({
      messages: [USER, assistant({ content: 'Sure. More.', loading: false })],
      processing: false
    });
    expect(hook.result.current.state.notice).toBeNull();

    act(() => mockHandlers.queue.onError(new Error('Speech request failed: 403')));
    expect(hook.result.current.state.notice).toBe('tts-failed');
    const noticed = hook.result.current.state;
    act(() => mockHandlers.queue.onError(new Error('Speech request failed: 403')));
    expect(hook.result.current.state).toBe(noticed);
    // The reason still goes to the log.
    expect(debugLog).toHaveBeenCalledWith('voiceMode: text-to-speech failed', expect.any(Error));
  });

  test('the notice goes when the user speaks again', async () => {
    const hook = setup();
    await startAndReady(hook);
    act(() => mockHandlers.queue.onError(new Error('429')));
    expect(hook.result.current.state.notice).toBe('tts-failed');
    emit({ type: 'speech-start' });
    expect(hook.result.current.state.notice).toBeNull();
  });

  test('the notice goes with the next turn that is sent', async () => {
    const hook = setup();
    await startAndReady(hook);
    emit({ type: 'speech-start' });
    act(() => mockHandlers.queue.onError(new Error('500')));
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Hello there' });
    });
    expect(hook.result.current.state.notice).toBeNull();
  });

  test('a failure of a session that was ended does not show up in the next one', async () => {
    const hook = setup();
    await startAndReady(hook);
    const staleQueue = mockHandlers.queue;
    act(() => hook.result.current.end('user'));
    await startAndReady(hook);
    act(() => staleQueue.onError(new Error('late')));
    expect(hook.result.current.state.notice).toBeNull();
  });

  test('a retry starts without the notice', async () => {
    const hook = setup();
    await startAndReady(hook);
    act(() => mockHandlers.queue.onError(new Error('500')));
    emit({ type: 'error', code: 'connection', message: '', recoverable: false });
    await act(async () => {
      await hook.result.current.retry();
    });
    expect(hook.result.current.state.notice).toBeNull();
  });
});

describe('the server ending a conversation nobody spoke in', () => {
  test('no-speech reaches the state as the error code', async () => {
    const hook = setup();
    await startAndReady(hook);
    emit({
      type: 'error',
      code: 'no-speech',
      message: 'Nothing was said for a long time, so the session was closed',
      recoverable: false
    });
    emit({ type: 'closed' });
    expect(status(hook)).toBe('error');
    expect(hook.result.current.state.error.code).toBe('no-speech');
    expect(mockSession.stop).toHaveBeenCalled();
  });
});

describe('the timing of a turn', () => {
  let clock;
  let spy;
  beforeEach(() => {
    clock = 10_000;
    spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    debugLog.mockClear();
  });
  afterEach(() => spy.mockRestore());

  const reports = () =>
    debugLog.mock.calls.filter(
      ([name, data]) => name === 'voiceMode.timing' && 'firstAudio' in data
    );

  test('is logged when the first audio starts, after the VAD speech end, with the silence that preceded it', async () => {
    const hook = setup({ availability: availability({ endOfTurnSilenceMs: 700 }) });
    await startAndReady(hook);
    emit({ type: 'speech-start' });
    clock = 12_000;
    emit({ type: 'turn-end' });
    clock = 12_300;
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Hello there' });
    });
    clock = 12_900;
    hook.setProps({ messages: [USER, assistant({ content: 'Hi. How' })], processing: true });
    clock = 13_100;
    act(() => mockHandlers.queue.onTiming('firstChunk', 200));
    expect(reports()).toHaveLength(0);

    clock = 13_600;
    act(() => mockHandlers.queue.onSpeakingStart());
    expect(reports()).toEqual([
      [
        'voiceMode.timing',
        {
          endOfTurnSilenceMs: 700,
          sttFinal: 300,
          firstToken: 900,
          firstChunk: 1100,
          firstAudio: 1600
        }
      ]
    ]);
  });

  test('an interrupted turn is logged too, once, and the drain adds nothing', async () => {
    const hook = setup();
    await startAndReady(hook);
    emit({ type: 'speech-start' });
    clock = 11_000;
    emit({ type: 'turn-end' });
    clock = 11_200;
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Hello there' });
    });
    hook.setProps({
      messages: [USER, assistant({ content: 'A long one. Goes on' })],
      processing: true
    });
    clock = 11_900;
    act(() => mockHandlers.queue.onSpeakingStart());
    emit({ type: 'barge-in' });
    act(() => mockHandlers.queue.onDrained());
    expect(reports()).toHaveLength(1);
    expect(reports()[0][1]).toMatchObject({
      endOfTurnSilenceMs: 800,
      sttFinal: 200,
      firstAudio: 900
    });
  });

  test('stages that did not happen are null; audio that follows in the same turn is not logged again', async () => {
    const hook = setup();
    await startAndReady(hook);
    emit({ type: 'speech-start' });
    clock = 11_000;
    emit({ type: 'turn-end' });
    await act(async () => {
      mockHandlers.onEvent({ type: 'final', text: 'Hello there' });
    });
    clock = 11_500;
    act(() => mockHandlers.queue.onSpeakingStart());
    act(() => mockHandlers.queue.onDrained());
    clock = 12_500;
    act(() => mockHandlers.queue.onSpeakingStart());
    expect(reports()).toHaveLength(1);
    expect(reports()[0][1]).toEqual({
      endOfTurnSilenceMs: 800,
      sttFinal: 0,
      firstToken: null,
      firstChunk: null,
      firstAudio: 500
    });
  });

  test('speech with no turn behind it (an error message) logs nothing', async () => {
    const sendTurn = jest.fn(async () => false);
    const hook = setup({ sendTurn });
    await startAndReady(hook);
    await speakTurn();
    act(() => mockHandlers.queue.onSpeakingStart());
    expect(reports()).toHaveLength(0);
  });
});
