/**
 * Voice mode (issue #2868): the turn loop is a pure reducer, so every
 * transition — including barge-in while thinking and while speaking, and the
 * late events that must be ignored — is tested without audio or React.
 */

import {
  VOICE_STATUS as S,
  initialVoiceModeState,
  isDroppedTranscript,
  voiceModeReducer
} from '../../../client/src/features/voice/utils/voiceModeReducer';

/** Apply actions in order (a bare string is an action with that type). */
const run = (state, ...actions) =>
  actions.reduce(
    (current, action) =>
      voiceModeReducer(current, typeof action === 'string' ? { type: action } : action),
    state
  );

const fresh = opts =>
  initialVoiceModeState({ listeningStyle: 'hands-free', bargeIn: true, ...opts });
const listening = opts => run(fresh(opts), 'READY');
const userSpeaking = opts => run(listening(opts), 'SPEECH_START');
const thinking = opts =>
  run(
    userSpeaking(opts),
    { type: 'INTERIM', text: 'what is the weather' },
    'TURN_ENDED',
    { type: 'FINAL', text: 'What is the weather?' },
    'SENT'
  );
const speaking = opts =>
  run(thinking(opts), { type: 'ASSISTANT_TEXT', text: 'It is sunny.' }, 'PLAYBACK_STARTED');

describe('initialVoiceModeState', () => {
  test('starts connecting with empty captions', () => {
    expect(
      initialVoiceModeState({ listeningStyle: 'push-to-talk', bargeIn: false, captions: false })
    ).toEqual({
      status: 'connecting',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      captions: false,
      muted: false,
      userCaption: { text: '', final: false },
      assistantCaption: '',
      spokenChars: null,
      toolStatus: null,
      error: null,
      notice: null,
      turn: 0,
      runActive: false
    });
  });

  test('has sensible defaults and tolerates no arguments', () => {
    const state = initialVoiceModeState();
    expect(state).toMatchObject({ listeningStyle: 'hands-free', bargeIn: true, captions: true });
    expect(initialVoiceModeState({ listeningStyle: 'nonsense' }).listeningStyle).toBe('hands-free');
  });

  test('VOICE_STATUS names every status', () => {
    expect(S).toEqual({
      CONNECTING: 'connecting',
      LISTENING: 'listening',
      USER_SPEAKING: 'user-speaking',
      THINKING: 'thinking',
      SPEAKING: 'speaking',
      PAUSED: 'paused',
      ERROR: 'error'
    });
  });
});

describe('the turn loop', () => {
  test('listening → user-speaking → thinking → speaking → listening', () => {
    let state = fresh();
    expect(state.status).toBe(S.CONNECTING);

    state = run(state, 'READY');
    expect(state.status).toBe(S.LISTENING);

    state = run(state, 'SPEECH_START');
    expect(state.status).toBe(S.USER_SPEAKING);

    state = run(state, { type: 'INTERIM', text: 'what is' });
    expect(state.userCaption).toEqual({ text: 'what is', final: false });
    state = run(state, { type: 'INTERIM', text: 'what is the weather' });
    expect(state.userCaption.text).toBe('what is the weather');

    state = run(state, 'TURN_ENDED');
    expect(state.status).toBe(S.THINKING);
    expect(state.runActive).toBe(false);

    state = run(state, { type: 'FINAL', text: '  What is the weather?  ' });
    expect(state.status).toBe(S.THINKING);
    expect(state.userCaption).toEqual({ text: 'What is the weather?', final: true });

    state = run(state, 'SENT');
    expect(state).toMatchObject({ status: S.THINKING, runActive: true, turn: 1 });

    state = run(state, { type: 'ASSISTANT_TEXT', text: 'It is' });
    expect(state.assistantCaption).toBe('It is');
    expect(state.status).toBe(S.THINKING);

    state = run(state, 'PLAYBACK_STARTED');
    expect(state.status).toBe(S.SPEAKING);
    state = run(state, { type: 'ASSISTANT_TEXT', text: 'It is sunny.' });
    expect(state.assistantCaption).toBe('It is sunny.');

    state = run(state, 'RUN_ENDED');
    expect(state).toMatchObject({ status: S.SPEAKING, runActive: false });

    state = run(state, 'PLAYBACK_DRAINED');
    expect(state.status).toBe(S.LISTENING);
    // The answer stays readable until the next turn starts.
    expect(state.assistantCaption).toBe('It is sunny.');
  });

  test('the next turn clears the old answer and counts up', () => {
    const state = run(
      speaking(),
      'RUN_ENDED',
      'PLAYBACK_DRAINED',
      'SPEECH_START',
      { type: 'FINAL', text: 'And tomorrow?' },
      'SENT'
    );
    expect(state).toMatchObject({ turn: 2, assistantCaption: '', status: S.THINKING });
  });

  test('speech start clears the previous user caption', () => {
    const state = run(
      listening(),
      'SPEECH_START',
      { type: 'INTERIM', text: 'old words' },
      'TURN_ENDED',
      { type: 'FINAL', text: 'old words here' },
      'SENT',
      'RUN_ENDED',
      'SPEECH_START'
    );
    expect(state.status).toBe(S.USER_SPEAKING);
    expect(state.userCaption).toEqual({ text: '', final: false });
  });

  test('an interim transcript in listening means the user is speaking', () => {
    const state = run(listening(), { type: 'INTERIM', text: 'hello' });
    expect(state).toMatchObject({ status: S.USER_SPEAKING, userCaption: { text: 'hello' } });
  });

  test('a streaming recogniser may still deliver text after the turn ended', () => {
    const state = run(userSpeaking(), 'TURN_ENDED', { type: 'INTERIM', text: 'late words' });
    expect(state).toMatchObject({
      status: S.THINKING,
      userCaption: { text: 'late words', final: false }
    });
  });

  test('a final transcript while the user is speaking again is the first part, not a turn', () => {
    // The pause cut the sentence; the transcript of the first half arrives after
    // the user has started the second.
    const state = run(userSpeaking(), { type: 'FINAL', text: 'Please tell me about' });
    expect(state).toMatchObject({
      status: S.USER_SPEAKING,
      userCaption: { text: 'Please tell me about', final: false },
      runActive: false,
      turn: 0
    });
    // The turn that is sent is the one the user ends.
    expect(
      run(state, 'TURN_ENDED', { type: 'FINAL', text: 'Please tell me about Berlin' })
    ).toMatchObject({
      status: S.THINKING,
      userCaption: { text: 'Please tell me about Berlin', final: true }
    });
  });

  test('a dropped or repeated first part changes nothing while the user speaks', () => {
    const state = run(userSpeaking(), { type: 'INTERIM', text: 'and the weather' });
    for (const text of ['', '  ', 'uh', undefined]) {
      expect(voiceModeReducer(state, { type: 'FINAL', text })).toBe(state);
    }
    const shown = run(state, { type: 'FINAL', text: 'Tell me' });
    expect(voiceModeReducer(shown, { type: 'FINAL', text: 'Tell me' })).toBe(shown);
  });

  test('events that do not fit the status return the same state', () => {
    const state = listening();
    for (const action of [
      'TURN_ENDED',
      'PLAYBACK_DRAINED',
      'TOOL_FINISHED',
      'BARGE_IN',
      'UNMUTE',
      'RETRY',
      { type: 'TOOL_STARTED', kind: 'web', label: 'x' },
      { type: 'ASSISTANT_TEXT', text: 'stale' },
      'READY'
    ]) {
      expect(voiceModeReducer(state, typeof action === 'string' ? { type: action } : action)).toBe(
        state
      );
    }
  });

  test('speech while the user is already speaking changes nothing', () => {
    const state = userSpeaking();
    expect(voiceModeReducer(state, { type: 'SPEECH_START' })).toBe(state);
  });

  test('nothing happens before the connection is ready', () => {
    const state = fresh();
    for (const type of ['SPEECH_START', 'TURN_ENDED', 'PLAYBACK_STARTED', 'BARGE_IN', 'FINAL']) {
      expect(voiceModeReducer(state, { type, text: 'hello there' })).toBe(state);
    }
    expect(voiceModeReducer(state, { type: 'SENT' })).toBe(state);
  });
});

describe('barge-in', () => {
  test('from speaking: the user takes the turn, the answer is cleared', () => {
    const state = run(
      speaking(),
      { type: 'TOOL_STARTED', kind: 'web', label: 'Searching' },
      'BARGE_IN'
    );
    expect(state).toMatchObject({
      status: S.USER_SPEAKING,
      assistantCaption: '',
      toolStatus: null,
      runActive: false,
      userCaption: { text: '', final: false }
    });
    // The turn counter is not touched: nothing was sent.
    expect(state.turn).toBe(1);
  });

  test('from thinking (the run is still going)', () => {
    const before = run(thinking(), { type: 'TOOL_STARTED', kind: 'web', label: 'Searching' });
    expect(before.toolStatus).toEqual({ kind: 'web', label: 'Searching' });
    const state = voiceModeReducer(before, { type: 'BARGE_IN' });
    expect(state).toMatchObject({
      status: S.USER_SPEAKING,
      toolStatus: null,
      assistantCaption: '',
      runActive: false,
      userCaption: { text: '', final: false }
    });
  });

  test('keeps the user caption fresh, not the old question', () => {
    const state = run(speaking(), 'BARGE_IN', { type: 'INTERIM', text: 'wait, no' });
    expect(state.userCaption).toEqual({ text: 'wait, no', final: false });
  });

  test('speech start while speaking or thinking barges in when enabled', () => {
    expect(run(speaking(), 'SPEECH_START').status).toBe(S.USER_SPEAKING);
    expect(run(thinking(), 'SPEECH_START').status).toBe(S.USER_SPEAKING);
  });

  test('speech start while speaking is ignored when barge-in is off', () => {
    const state = speaking({ bargeIn: false });
    expect(voiceModeReducer(state, { type: 'SPEECH_START' })).toBe(state);
    const waiting = thinking({ bargeIn: false });
    expect(voiceModeReducer(waiting, { type: 'SPEECH_START' })).toBe(waiting);
  });

  test('BARGE_IN is ignored when barge-in is off', () => {
    const state = speaking({ bargeIn: false });
    expect(voiceModeReducer(state, { type: 'BARGE_IN' })).toBe(state);
  });

  test('BARGE_IN with force works with barge-in off (a tap on the orb) and listens', () => {
    for (const make of [speaking, thinking]) {
      const state = run(make({ bargeIn: false }), { type: 'BARGE_IN', force: true });
      // Nobody speaks yet: the app stopped and listens.
      expect(state).toMatchObject({
        status: S.LISTENING,
        runActive: false,
        assistantCaption: '',
        toolStatus: null,
        userCaption: { text: '', final: false }
      });
    }
  });

  test('a tap on the orb while nothing plays changes nothing', () => {
    const l = listening();
    expect(voiceModeReducer(l, { type: 'BARGE_IN', force: true })).toBe(l);
  });

  test('BARGE_IN is ignored while paused', () => {
    const state = run(speaking(), 'MUTE');
    expect(state.status).toBe(S.PAUSED);
    expect(voiceModeReducer(state, { type: 'BARGE_IN' })).toBe(state);
    expect(voiceModeReducer(state, { type: 'BARGE_IN', force: true })).toBe(state);
    expect(voiceModeReducer(state, { type: 'SPEECH_START' })).toBe(state);
  });

  test('BARGE_IN while listening or user-speaking is ignored', () => {
    const l = listening();
    expect(voiceModeReducer(l, { type: 'BARGE_IN' })).toBe(l);
    const u = userSpeaking();
    expect(voiceModeReducer(u, { type: 'BARGE_IN' })).toBe(u);
  });

  test('the aborted run cannot drag the state around afterwards', () => {
    const interrupted = run(speaking(), 'BARGE_IN');
    // Stale events of the run the hook aborted.
    expect(voiceModeReducer(interrupted, { type: 'ASSISTANT_TEXT', text: 'old answer' })).toBe(
      interrupted
    );
    expect(voiceModeReducer(interrupted, { type: 'TOOL_STARTED', kind: 'web', label: 'x' })).toBe(
      interrupted
    );
    expect(voiceModeReducer(interrupted, { type: 'PLAYBACK_STARTED' })).toBe(interrupted);
    expect(voiceModeReducer(interrupted, { type: 'PLAYBACK_DRAINED' })).toBe(interrupted);
    expect(voiceModeReducer(interrupted, { type: 'RUN_ENDED' })).toBe(interrupted);
  });

  test('the interrupting turn goes on to be sent', () => {
    const state = run(
      speaking(),
      'BARGE_IN',
      'TURN_ENDED',
      { type: 'FINAL', text: 'Actually, Berlin' },
      'SENT'
    );
    expect(state).toMatchObject({ status: S.THINKING, runActive: true, turn: 2 });
  });
});

describe('transcripts that are dropped', () => {
  test.each([
    [''],
    ['   '],
    ['a'],
    ['uh'],
    ['Um...'],
    ['hmm'],
    ['äh'],
    ['Ähm,'],
    ['mhm'],
    ['Öh.'],
    ['uh, um']
  ])('FINAL %j goes back to listening without a send', text => {
    const state = run(userSpeaking(), { type: 'INTERIM', text: 'something' }, 'TURN_ENDED', {
      type: 'FINAL',
      text
    });
    expect(state).toMatchObject({
      status: S.LISTENING,
      userCaption: { text: '', final: false },
      runActive: false,
      turn: 0
    });
  });

  test('a dropped final in listening changes nothing', () => {
    const state = listening();
    expect(voiceModeReducer(state, { type: 'FINAL', text: 'uh' })).toBe(state);
  });

  test('a final without text is dropped', () => {
    expect(run(userSpeaking(), 'TURN_ENDED', { type: 'FINAL' }).status).toBe(S.LISTENING);
  });

  test('a real transcript is not dropped', () => {
    expect(run(userSpeaking(), 'TURN_ENDED', { type: 'FINAL', text: 'ok' }).status).toBe(
      S.THINKING
    );
  });

  test('a final that arrives while the app speaks and nobody barged in is ignored', () => {
    const state = speaking({ bargeIn: false });
    expect(voiceModeReducer(state, { type: 'FINAL', text: 'echo of the answer' })).toBe(state);
    const waiting = thinking();
    expect(voiceModeReducer(waiting, { type: 'FINAL', text: 'late words' })).toBe(waiting);
  });
});

describe('isDroppedTranscript', () => {
  test.each([
    ['', true],
    [' ', true],
    ['a', true],
    [' x ', true],
    ['uh', true],
    ['Uh.', true],
    ['um', true],
    ['uhm', true],
    ['uhhh', true],
    ['hmm', true],
    ['hmmmm', true],
    ['mhm', true],
    ['äh', true],
    ['ähm', true],
    ['ähhh...', true],
    ['öh', true],
    ['uh um hmm', true],
    ['äh, ähm.', true],
    ['...', true],
    ['?!', true],
    [undefined, true],
    [null, true],
    [42, true],
    ['ok', false],
    ['no', false],
    ['hi', false],
    ['uh what time is it', false],
    ['äh was kostet das', false],
    ['Um 8 Uhr', false],
    ['What is the weather?', false],
    ['12', false]
  ])('%j → %s', (text, dropped) => {
    expect(isDroppedTranscript(text)).toBe(dropped);
  });
});

describe('the end of the run and of the audio', () => {
  test('RUN_ENDED while thinking with no audio returns to listening', () => {
    const state = run(thinking(), 'RUN_ENDED');
    expect(state).toMatchObject({ status: S.LISTENING, runActive: false });
  });

  test('RUN_ENDED while thinking with audio still queued waits for the audio', () => {
    const waiting = run(thinking(), { type: 'RUN_ENDED', pendingAudio: true });
    expect(waiting).toMatchObject({ status: S.THINKING, runActive: false });
    // Audio starts and drains.
    expect(run(waiting, 'PLAYBACK_STARTED', 'PLAYBACK_DRAINED').status).toBe(S.LISTENING);
    // Or every chunk fails: it drains without ever playing.
    expect(run(waiting, 'PLAYBACK_DRAINED').status).toBe(S.LISTENING);
  });

  test('RUN_ENDED clears the tool chip', () => {
    const state = run(
      thinking(),
      { type: 'TOOL_STARTED', kind: 'web', label: 'Searching' },
      'RUN_ENDED'
    );
    expect(state.toolStatus).toBeNull();
  });

  test('RUN_ENDED while speaking keeps speaking until the audio drains', () => {
    expect(run(speaking(), 'RUN_ENDED').status).toBe(S.SPEAKING);
  });

  test('PLAYBACK_DRAINED with a run still active stays thinking', () => {
    // Audio caught up with the text: the next sentences are still being written.
    expect(run(speaking(), 'PLAYBACK_DRAINED')).toMatchObject({
      status: S.THINKING,
      runActive: true
    });
    const waiting = thinking();
    expect(voiceModeReducer(waiting, { type: 'PLAYBACK_DRAINED' })).toBe(waiting);
  });

  test('speech may start again after the audio caught up with a running answer', () => {
    const state = run(speaking(), 'PLAYBACK_DRAINED', 'PLAYBACK_STARTED');
    expect(state.status).toBe(S.SPEAKING);
  });

  test('PLAYBACK_DRAINED without a run returns to listening', () => {
    const state = run(speaking(), 'RUN_ENDED', 'PLAYBACK_DRAINED');
    expect(state.status).toBe(S.LISTENING);
  });

  test('audio that drains after the user started talking is ignored', () => {
    const state = run(speaking(), 'BARGE_IN');
    expect(voiceModeReducer(state, { type: 'PLAYBACK_DRAINED' })).toBe(state);
  });

  test('a spoken message after a finished run (error text) plays from listening', () => {
    const state = run(thinking(), 'RUN_ENDED', 'PLAYBACK_STARTED');
    expect(state.status).toBe(S.SPEAKING);
    expect(run(state, 'PLAYBACK_DRAINED').status).toBe(S.LISTENING);
  });
});

describe('tool status', () => {
  test('is set while the run is active and cleared when the tool finishes', () => {
    let state = run(thinking(), {
      type: 'TOOL_STARTED',
      kind: 'webSearch',
      label: 'Searching the web…'
    });
    expect(state.toolStatus).toEqual({ kind: 'webSearch', label: 'Searching the web…' });
    state = run(state, 'TOOL_FINISHED');
    expect(state.toolStatus).toBeNull();
    expect(state.status).toBe(S.THINKING);
  });

  test('a second tool replaces the first', () => {
    const state = run(
      thinking(),
      { type: 'TOOL_STARTED', kind: 'a', label: 'A' },
      { type: 'TOOL_STARTED', kind: 'b', label: 'B' }
    );
    expect(state.toolStatus).toEqual({ kind: 'b', label: 'B' });
  });

  test('the same tool again changes nothing', () => {
    const state = run(thinking(), { type: 'TOOL_STARTED', kind: 'a', label: 'A' });
    expect(voiceModeReducer(state, { type: 'TOOL_STARTED', kind: 'a', label: 'A' })).toBe(state);
  });

  test('is ignored when no run is active', () => {
    const state = listening();
    expect(voiceModeReducer(state, { type: 'TOOL_STARTED', kind: 'a', label: 'A' })).toBe(state);
  });

  test('a new send clears it', () => {
    const state = run(
      thinking(),
      { type: 'TOOL_STARTED', kind: 'a', label: 'A' },
      'RUN_ENDED',
      'SENT'
    );
    expect(state.toolStatus).toBeNull();
  });
});

describe('mute', () => {
  test('MUTE → paused, UNMUTE → listening', () => {
    let state = run(listening(), 'MUTE');
    expect(state).toMatchObject({ status: S.PAUSED, muted: true });
    state = run(state, 'UNMUTE');
    expect(state).toMatchObject({ status: S.LISTENING, muted: false });
  });

  test('unmuting while the app still works on the answer goes back to thinking, not listening', () => {
    // Muting silences the audio, the run goes on; "listening" with a run active
    // would let the next transcript start a second run on top of the first.
    const muted = run(thinking(), 'MUTE');
    expect(muted).toMatchObject({ status: S.PAUSED, runActive: true });
    expect(run(muted, 'UNMUTE')).toMatchObject({
      status: S.THINKING,
      muted: false,
      runActive: true
    });
    // Once the run has ended there is nothing to wait for.
    expect(run(muted, 'RUN_ENDED', 'UNMUTE').status).toBe(S.LISTENING);
  });

  test('muting twice or unmuting twice changes nothing', () => {
    const muted = run(listening(), 'MUTE');
    expect(voiceModeReducer(muted, { type: 'MUTE' })).toBe(muted);
    const open = listening();
    expect(voiceModeReducer(open, { type: 'UNMUTE' })).toBe(open);
  });

  test('muting mid-utterance drops the utterance', () => {
    const state = run(userSpeaking(), { type: 'INTERIM', text: 'half a sentence' }, 'MUTE');
    expect(state).toMatchObject({ status: S.PAUSED, userCaption: { text: '', final: false } });
  });

  test('a paused session hears nothing', () => {
    const state = run(listening(), 'MUTE');
    expect(voiceModeReducer(state, { type: 'SPEECH_START' })).toBe(state);
    expect(voiceModeReducer(state, { type: 'FINAL', text: 'Something said' })).toBe(state);
  });

  test('muting while connecting waits for the connection', () => {
    let state = run(fresh(), 'MUTE');
    expect(state).toMatchObject({ status: S.CONNECTING, muted: true });
    state = run(state, 'READY');
    expect(state.status).toBe(S.PAUSED);
    expect(run(state, 'UNMUTE').status).toBe(S.LISTENING);
  });

  test('muting while the app speaks pauses the loop; the run may still end', () => {
    const state = run(speaking(), 'MUTE', 'RUN_ENDED');
    expect(state).toMatchObject({ status: S.PAUSED, runActive: false });
    expect(run(state, 'UNMUTE').status).toBe(S.LISTENING);
  });

  test('a paused session shows the answer that is still coming in', () => {
    const state = run(thinking(), 'MUTE', { type: 'ASSISTANT_TEXT', text: 'Still talking' });
    expect(state.assistantCaption).toBe('Still talking');
  });

  test('a send while paused keeps it paused', () => {
    const state = run(userSpeaking(), 'MUTE', 'SENT');
    expect(state).toMatchObject({ status: S.PAUSED, runActive: true });
  });
});

describe('errors', () => {
  test.each([
    ['connecting', () => fresh()],
    ['listening', () => listening()],
    ['user-speaking', () => userSpeaking()],
    ['thinking', () => thinking()],
    ['speaking', () => speaking()],
    ['paused', () => run(listening(), 'MUTE')]
  ])('ERROR from %s', (_name, make) => {
    const state = run(make(), { type: 'ERROR', code: 'stt-closed', message: 'Connection lost' });
    expect(state).toMatchObject({
      status: S.ERROR,
      error: { code: 'stt-closed', message: 'Connection lost' },
      runActive: false,
      toolStatus: null
    });
  });

  test('ERROR without details still has an error object', () => {
    expect(run(listening(), 'ERROR').error).toEqual({ code: 'error', message: '' });
  });

  test('RETRY → connecting, clears the error and the old turn; READY → listening', () => {
    let state = run(speaking(), { type: 'ERROR', code: 'x', message: 'y' });
    state = run(state, 'RETRY');
    expect(state).toMatchObject({
      status: S.CONNECTING,
      error: null,
      runActive: false,
      assistantCaption: '',
      userCaption: { text: '', final: false }
    });
    state = run(state, 'READY');
    expect(state.status).toBe(S.LISTENING);
  });

  test('a retry starts unmuted: the new session is not muted, so the state must not say so', () => {
    let state = run(listening(), 'MUTE', { type: 'ERROR', code: 'connection' });
    expect(state.muted).toBe(true);
    state = run(state, 'RETRY');
    expect(state).toMatchObject({ status: S.CONNECTING, muted: false });
    expect(run(state, 'READY').status).toBe(S.LISTENING);
  });

  test('the turn count survives an error and a retry', () => {
    const state = run(speaking(), { type: 'ERROR', code: 'x' }, 'RETRY', 'READY');
    expect(state.turn).toBe(1);
  });

  test('events are ignored while in error, except RETRY', () => {
    const state = run(listening(), { type: 'ERROR', code: 'x', message: 'y' });
    for (const action of [
      { type: 'SPEECH_START' },
      { type: 'FINAL', text: 'hello there' },
      { type: 'SENT' },
      { type: 'READY' },
      { type: 'BARGE_IN', force: true }
    ]) {
      expect(voiceModeReducer(state, action)).toBe(state);
    }
  });

  test('muting in the error state keeps the error', () => {
    const state = run(listening(), { type: 'ERROR', code: 'x', message: 'y' }, 'MUTE');
    expect(state).toMatchObject({ status: S.ERROR, muted: true });
  });
});

describe('notice', () => {
  test('NOTICE tts-failed is set once and shown with the state otherwise unchanged', () => {
    const before = speaking();
    const state = run(before, { type: 'NOTICE', notice: 'tts-failed' });
    expect(state).toEqual({ ...before, notice: 'tts-failed' });
    expect(voiceModeReducer(state, { type: 'NOTICE', notice: 'tts-failed' })).toBe(state);
  });

  test('an unknown notice is ignored', () => {
    const state = listening();
    expect(voiceModeReducer(state, { type: 'NOTICE', notice: 'other' })).toBe(state);
    expect(voiceModeReducer(state, { type: 'NOTICE' })).toBe(state);
  });

  test.each([
    ['READY', () => run(fresh(), { type: 'NOTICE', notice: 'tts-failed' }), 'READY'],
    [
      'SPEECH_START',
      () => run(listening(), { type: 'NOTICE', notice: 'tts-failed' }),
      'SPEECH_START'
    ],
    ['SENT', () => run(userSpeaking(), { type: 'NOTICE', notice: 'tts-failed' }), 'SENT'],
    [
      'RETRY',
      () => run(listening(), { type: 'NOTICE', notice: 'tts-failed' }, { type: 'ERROR' }),
      'RETRY'
    ],
    ['BARGE_IN', () => run(speaking(), { type: 'NOTICE', notice: 'tts-failed' }), 'BARGE_IN']
  ])('%s clears it', (_name, make, action) => {
    const noticed = make();
    expect(noticed.notice).toBe('tts-failed');
    expect(run(noticed, action).notice).toBeNull();
  });

  test('speech that starts with an interim transcript clears it too', () => {
    const noticed = run(listening(), { type: 'NOTICE', notice: 'tts-failed' });
    expect(run(noticed, { type: 'INTERIM', text: 'hello' }).notice).toBeNull();
  });

  test('the notice stays while the app goes on thinking, speaking and listening', () => {
    const noticed = run(speaking(), { type: 'NOTICE', notice: 'tts-failed' });
    expect(run(noticed, 'RUN_ENDED', 'PLAYBACK_DRAINED')).toMatchObject({
      status: S.LISTENING,
      notice: 'tts-failed'
    });
  });
});

describe('settings and unknown actions', () => {
  test('SET_LISTENING_STYLE accepts the two styles only', () => {
    const state = listening();
    expect(run(state, { type: 'SET_LISTENING_STYLE', style: 'push-to-talk' }).listeningStyle).toBe(
      'push-to-talk'
    );
    expect(voiceModeReducer(state, { type: 'SET_LISTENING_STYLE', style: 'hands-free' })).toBe(
      state
    );
    expect(voiceModeReducer(state, { type: 'SET_LISTENING_STYLE', style: 'bogus' })).toBe(state);
  });

  test('SET_BARGE_IN and SET_CAPTIONS', () => {
    const state = listening();
    expect(run(state, { type: 'SET_BARGE_IN', value: false }).bargeIn).toBe(false);
    expect(run(state, { type: 'SET_CAPTIONS', value: false }).captions).toBe(false);
    expect(voiceModeReducer(state, { type: 'SET_BARGE_IN', value: true })).toBe(state);
    expect(voiceModeReducer(state, { type: 'SET_CAPTIONS', value: true })).toBe(state);
  });

  test('turning barge-in off takes effect for the next event', () => {
    const state = run(speaking(), { type: 'SET_BARGE_IN', value: false });
    expect(voiceModeReducer(state, { type: 'SPEECH_START' })).toBe(state);
  });

  test('an unknown action returns the same state reference', () => {
    const state = speaking();
    expect(voiceModeReducer(state, { type: 'SOMETHING_ELSE' })).toBe(state);
    expect(voiceModeReducer(state, {})).toBe(state);
    expect(voiceModeReducer(state, undefined)).toBe(state);
    expect(voiceModeReducer(state, null)).toBe(state);
  });

  test('the reducer does not mutate the state', () => {
    const state = Object.freeze({ ...thinking() });
    expect(() => voiceModeReducer(state, { type: 'BARGE_IN' })).not.toThrow();
    expect(state.status).toBe(S.THINKING);
  });
});

describe('how much of the answer has been spoken', () => {
  const answer = 'It is sunny today. Tomorrow it rains.';
  const playing = () =>
    run(thinking(), { type: 'ASSISTANT_TEXT', text: answer }, 'PLAYBACK_STARTED');

  test('is not marked until the audio plays, and starts at nothing spoken', () => {
    const waiting = run(thinking(), { type: 'ASSISTANT_TEXT', text: answer });
    expect(waiting.spokenChars).toBeNull();
    expect(playing().spokenChars).toBe(0);
  });

  test('moves forward with the audio and never back', () => {
    const state = run(playing(), { type: 'SPOKEN_PROGRESS', chars: 8 });
    expect(state.spokenChars).toBe(8);
    expect(run(state, { type: 'SPOKEN_PROGRESS', chars: 18 }).spokenChars).toBe(18);
    expect(run(state, { type: 'SPOKEN_PROGRESS', chars: 3 })).toBe(state);
    expect(run(state, { type: 'SPOKEN_PROGRESS', chars: 8 })).toBe(state);
  });

  test('cannot pass the end of the caption, and ignores what is no number', () => {
    expect(run(playing(), { type: 'SPOKEN_PROGRESS', chars: 9999 }).spokenChars).toBe(
      answer.length
    );
    const state = playing();
    expect(run(state, { type: 'SPOKEN_PROGRESS', chars: Number.NaN })).toBe(state);
    expect(run(state, { type: 'SPOKEN_PROGRESS' })).toBe(state);
  });

  test('is only taken while speaking', () => {
    const state = thinking();
    expect(run(state, { type: 'SPOKEN_PROGRESS', chars: 5 })).toBe(state);
    const listeningState = listening();
    expect(run(listeningState, { type: 'SPOKEN_PROGRESS', chars: 5 })).toBe(listeningState);
  });

  test('stays put while more of the answer arrives, and is cut back if the text shrinks', () => {
    const state = run(playing(), { type: 'SPOKEN_PROGRESS', chars: 12 });
    expect(run(state, { type: 'ASSISTANT_TEXT', text: `${answer} More.` }).spokenChars).toBe(12);
    expect(run(state, { type: 'ASSISTANT_TEXT', text: 'It is' }).spokenChars).toBe(5);
  });

  test('is cleared when the audio has all played, so the caption is not marked any more', () => {
    const state = run(playing(), { type: 'SPOKEN_PROGRESS', chars: 12 });
    expect(run(state, 'RUN_ENDED', 'PLAYBACK_DRAINED').spokenChars).toBeNull();
    expect(run(state, 'PLAYBACK_DRAINED').spokenChars).toBeNull();
  });

  test.each([
    ['a barge-in', { type: 'BARGE_IN' }],
    ['a tap on the orb', { type: 'BARGE_IN', force: true }],
    ['muting', { type: 'MUTE' }],
    ['an error', { type: 'ERROR', code: 'closed' }]
  ])('is cleared by %s', (_name, action) => {
    const state = run(playing(), { type: 'SPOKEN_PROGRESS', chars: 12 });
    expect(run(state, action).spokenChars).toBeNull();
  });

  test('is cleared when a new turn is sent and when a session is retried', () => {
    const state = run(playing(), { type: 'SPOKEN_PROGRESS', chars: 12 }, 'RUN_ENDED');
    const next = run(state, 'PLAYBACK_DRAINED', 'SPEECH_START', 'TURN_ENDED', {
      type: 'FINAL',
      text: 'And the day after?'
    });
    expect(run(next, 'SENT').spokenChars).toBeNull();
    const failed = run(playing(), { type: 'ERROR', code: 'closed' }, 'RETRY');
    expect(failed.spokenChars).toBeNull();
  });
});
