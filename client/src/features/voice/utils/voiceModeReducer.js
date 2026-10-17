/**
 * The turn loop of voice mode (issue #2868) as a pure reducer.
 *
 * ```
 *   listening ─speech─▶ user-speaking ─turn ended─▶ thinking ─first audio─▶ speaking
 *       ▲                     ▲                        │                       │
 *       │                     └───── barge-in ─────────┴───────────────────────┤
 *       └─────────────────── playback drained, no run active ──────────────────┘
 * ```
 *
 * Four event sources drive it: the microphone (VAD), the speech-to-text
 * session, the chat stream and the audio player. The hook that wires them
 * dispatches their events here and acts on the resulting `status`; nothing in
 * here touches audio, the network or React, so every transition can be tested
 * without any of them.
 *
 * Events that do not fit the current status are ignored by returning the SAME
 * state object (so a `useReducer` consumer does not re-render). That is what
 * makes the loop robust against late events: a transcript that arrives while
 * the app speaks and barge-in is off, the end of a run the user already
 * interrupted, audio that drains after the user started talking.
 *
 * A transcript that arrives while the user is already talking again is not a
 * turn: it is the first part of a sentence the user paused in (the speech-to-text
 * answer for the turn the silence cut off). The state stays `user-speaking` and the
 * caption shows it; the hook keeps the text and puts it in front of the next one.
 *
 * `RUN_ENDED` and the tool and text events are not scoped to a run: after a
 * barge-in the hook must drop the events of the run it aborted. (A stale
 * `RUN_ENDED` while the next transcript is still pending only makes the status
 * flicker back to `listening`; the transcript's `FINAL` moves on again.)
 */

export const VOICE_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  USER_SPEAKING: 'user-speaking',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  PAUSED: 'paused',
  ERROR: 'error'
});

const { CONNECTING, LISTENING, USER_SPEAKING, THINKING, SPEAKING, PAUSED, ERROR } = VOICE_STATUS;

const LISTENING_STYLES = ['hands-free', 'push-to-talk'];
const EMPTY_USER_CAPTION = Object.freeze({ text: '', final: false });
/** What the overlay may be told besides the status (`state.notice`). */
const NOTICES = ['tts-failed'];

/**
 * Words a recogniser reports for a cough, a breath or a hesitation. Letters may
 * repeat ("uhhh", "ähhm").
 */
const FILLER_WORD = /^(?:u+h+m*|u+m+|h+m+|m+h+m+|m{2,}|ä+h+m*|ö+h+m*)$/u;

/**
 * Whether a final transcript is not worth a turn: under two characters, no
 * letter or digit at all (punctuation noise), or nothing but filler words
 * ("uh", "um", "hmm", "äh", "ähm", "mhm", "öh"). Such turns are dropped
 * silently (concept §4.9).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isDroppedTranscript(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length < 2) return true;
  const words = trimmed
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.length === 0 || words.every(word => FILLER_WORD.test(word));
}

/**
 * @param {Object} [opts]
 * @param {'hands-free'|'push-to-talk'} [opts.listeningStyle='hands-free']
 * @param {boolean} [opts.bargeIn=true] - Whether the user may interrupt the app.
 * @param {boolean} [opts.captions=true]
 *
 * `notice` is a hint the overlay shows next to the status: `'tts-failed'` (the
 * answer could not be spoken, the caption still has it) or null.
 */
export function initialVoiceModeState({ listeningStyle, bargeIn, captions = true } = {}) {
  return {
    status: CONNECTING,
    listeningStyle: LISTENING_STYLES.includes(listeningStyle) ? listeningStyle : 'hands-free',
    bargeIn: bargeIn !== false,
    captions: captions !== false,
    muted: false,
    userCaption: EMPTY_USER_CAPTION,
    assistantCaption: '',
    toolStatus: null,
    error: null,
    notice: null,
    turn: 0,
    runActive: false
  };
}

/**
 * The user takes over from the app: playback and run are the hook's to stop, this
 * is the state. Talking over the app (`force` false) means the user is speaking;
 * a tap on the orb (`force`) stops the app but nobody speaks yet, so it listens.
 */
function bargeInState(state, force) {
  if (state.status !== THINKING && state.status !== SPEAKING) return state;
  if (!state.bargeIn && !force) return state;
  return {
    ...state,
    status: force ? LISTENING : USER_SPEAKING,
    userCaption: EMPTY_USER_CAPTION,
    assistantCaption: '',
    toolStatus: null,
    notice: null,
    runActive: false
  };
}

/**
 * @param {ReturnType<typeof initialVoiceModeState>} state
 * @param {{ type: string } & Record<string, any>} action
 *   - `READY`: the microphone and the recogniser are up.
 *   - `SPEECH_START`: the user began to speak. While the app thinks or speaks
 *     this barges in, but only with `bargeIn` on.
 *   - `INTERIM {text}`: the transcript so far.
 *   - `TURN_ENDED`: silence or push-to-talk release; the final transcript follows.
 *   - `FINAL {text}`: the turn's transcript. An empty or filler transcript goes
 *     back to listening; otherwise it is the turn to send. Ignored while the app
 *     speaks or a run is active and the user did not barge in. While the user is
 *     speaking again it is only the first part of the sentence: it shows in the
 *     caption and changes nothing else.
 *   - `SENT`: the transcript was handed to the chat; a run is active now.
 *   - `TOOL_STARTED {kind, label}` / `TOOL_FINISHED`: the run's tool chip.
 *   - `ASSISTANT_TEXT {text}`: the answer so far (the caption).
 *   - `PLAYBACK_STARTED` / `PLAYBACK_DRAINED`: the first audio is playing / all
 *     of it has played.
 *   - `RUN_ENDED {pendingAudio?}`: the answer is complete. While thinking this
 *     returns to listening, unless `pendingAudio` says speech is still queued.
 *   - `BARGE_IN {force?}`: the user interrupts (from the session's barge-in
 *     event) and is speaking now. `force` is a tap on the orb: it also works with
 *     `bargeIn` off, and the state is `listening` (nobody speaks yet).
 *   - `NOTICE {notice}`: a hint for the overlay (`'tts-failed'`). Cleared by
 *     `READY`, `SPEECH_START`, `SENT` and `RETRY`, and by a barge-in.
 *   - `MUTE` / `UNMUTE`, `ERROR {code, message}`, `RETRY` (from `error` only),
 *     `SET_LISTENING_STYLE {style}`, `SET_BARGE_IN {value}`, `SET_CAPTIONS {value}`.
 * @returns {ReturnType<typeof initialVoiceModeState>} The same object for an
 *   action that changes nothing.
 */
export function voiceModeReducer(state, action) {
  switch (action?.type) {
    case 'READY':
      if (state.status !== CONNECTING) return state;
      return { ...state, status: state.muted ? PAUSED : LISTENING, error: null, notice: null };

    case 'SPEECH_START':
      if (state.status === LISTENING) {
        return { ...state, status: USER_SPEAKING, userCaption: EMPTY_USER_CAPTION, notice: null };
      }
      if (state.status === THINKING || state.status === SPEAKING) return bargeInState(state, false);
      return state;

    case 'INTERIM': {
      const text = typeof action.text === 'string' ? action.text : '';
      const caption = { text, final: false };
      if (state.status === LISTENING) {
        return { ...state, status: USER_SPEAKING, userCaption: caption, notice: null };
      }
      // A streaming recogniser may still deliver text after the turn ended.
      const awaitingFinal = state.status === THINKING && !state.runActive;
      if (state.status === USER_SPEAKING || awaitingFinal) {
        if (state.userCaption.text === text && !state.userCaption.final) return state;
        return { ...state, userCaption: caption };
      }
      return state;
    }

    case 'TURN_ENDED':
      return state.status === USER_SPEAKING ? { ...state, status: THINKING } : state;

    case 'FINAL': {
      const text = typeof action.text === 'string' ? action.text.trim() : '';
      if (state.status === USER_SPEAKING) {
        // The turn this transcript belongs to was cut off by a pause; the user
        // went on. Not a turn yet, and not the end of the speaking either.
        if (isDroppedTranscript(text)) return state;
        if (state.userCaption.text === text && !state.userCaption.final) return state;
        return { ...state, userCaption: { text, final: false } };
      }
      const accepting =
        state.status === LISTENING || (state.status === THINKING && !state.runActive);
      if (!accepting) return state;
      if (isDroppedTranscript(text)) {
        if (state.status === LISTENING && !state.userCaption.text) return state;
        return { ...state, status: LISTENING, userCaption: EMPTY_USER_CAPTION };
      }
      return { ...state, status: THINKING, userCaption: { text, final: true } };
    }

    case 'SENT':
      if (state.status === CONNECTING || state.status === ERROR) return state;
      return {
        ...state,
        status: state.status === PAUSED ? PAUSED : THINKING,
        assistantCaption: '',
        toolStatus: null,
        notice: null,
        turn: state.turn + 1,
        runActive: true
      };

    case 'TOOL_STARTED': {
      if (!state.runActive) return state;
      const kind = action.kind || 'tool';
      const label = action.label || '';
      if (state.toolStatus?.kind === kind && state.toolStatus.label === label) return state;
      return { ...state, toolStatus: { kind, label } };
    }

    case 'TOOL_FINISHED':
      return state.toolStatus ? { ...state, toolStatus: null } : state;

    case 'ASSISTANT_TEXT': {
      const text = typeof action.text === 'string' ? action.text : '';
      const showing =
        (state.status === THINKING && state.runActive) ||
        state.status === SPEAKING ||
        (state.status === PAUSED && state.runActive);
      if (!showing || state.assistantCaption === text) return state;
      return { ...state, assistantCaption: text };
    }

    case 'PLAYBACK_STARTED':
      if (state.status !== THINKING && state.status !== LISTENING) return state;
      return { ...state, status: SPEAKING };

    case 'PLAYBACK_DRAINED':
      if (state.status === SPEAKING) {
        return { ...state, status: state.runActive ? THINKING : LISTENING };
      }
      if (state.status === THINKING && !state.runActive) return { ...state, status: LISTENING };
      return state;

    case 'RUN_ENDED': {
      const toListening = state.status === THINKING && !action.pendingAudio;
      if (!state.runActive && !state.toolStatus && !toListening) return state;
      return {
        ...state,
        status: toListening ? LISTENING : state.status,
        runActive: false,
        toolStatus: null
      };
    }

    case 'BARGE_IN':
      return bargeInState(state, action.force === true);

    case 'NOTICE':
      if (!NOTICES.includes(action.notice) || state.notice === action.notice) return state;
      return { ...state, notice: action.notice };

    case 'MUTE': {
      const status = state.status === CONNECTING || state.status === ERROR ? state.status : PAUSED;
      if (state.muted && state.status === status) return state;
      return {
        ...state,
        muted: true,
        status,
        // An utterance cut off by muting is not sent.
        userCaption: state.status === USER_SPEAKING ? EMPTY_USER_CAPTION : state.userCaption
      };
    }

    case 'UNMUTE': {
      if (!state.muted) return state;
      // A run that went on while muted is still the app's turn to finish.
      const resumed = state.runActive ? THINKING : LISTENING;
      return { ...state, muted: false, status: state.status === PAUSED ? resumed : state.status };
    }

    case 'ERROR':
      return {
        ...state,
        status: ERROR,
        error: { code: action.code || 'error', message: action.message || '' },
        toolStatus: null,
        runActive: false
      };

    case 'RETRY':
      if (state.status !== ERROR) return state;
      return {
        ...state,
        status: CONNECTING,
        error: null,
        notice: null,
        // The new session starts unmuted, whatever the old one was.
        muted: false,
        userCaption: EMPTY_USER_CAPTION,
        assistantCaption: '',
        toolStatus: null,
        runActive: false
      };

    case 'SET_LISTENING_STYLE':
      if (!LISTENING_STYLES.includes(action.style) || action.style === state.listeningStyle) {
        return state;
      }
      return { ...state, listeningStyle: action.style };

    case 'SET_BARGE_IN':
      return Boolean(action.value) === state.bargeIn
        ? state
        : { ...state, bargeIn: Boolean(action.value) };

    case 'SET_CAPTIONS':
      return Boolean(action.value) === state.captions
        ? state
        : { ...state, captions: Boolean(action.value) };

    default:
      return state;
  }
}

export default voiceModeReducer;
