import { TARGET_SAMPLE_RATE, createLevelMeter, toPcm16At16k } from './voiceSession/audioUtils';
import { createAzureAdapter } from './voiceSession/azureAdapter';
import { createBrowserAdapter } from './voiceSession/browserAdapter';
import { createCapture } from './voiceSession/capture';
import { createModelAdapter } from './voiceSession/modelAdapter';
import { createPreRollBuffer } from './voiceSession/preRoll';
import { VAD_DEFAULTS, createVadController } from './voiceSession/vad';

/**
 * The microphone half of voice mode: one echo-cancelled microphone stream and one
 * AudioContext for the whole conversation, turn detection, and one speech-to-text
 * adapter per speech service that turns the user's turns into text.
 *
 *   microphone ─ capture (32 ms frames, 16 kHz PCM16) ─┬─ level meter (the orb)
 *        │                                              ├─ pre-roll ring buffer
 *        └─ Silero VAD (hands-free) ─ speech start/end ─┴─ adapter ─ model | azure | browser
 *
 * Hands-free turns are detected in the browser by Silero VAD (`vad.js`); while
 * nobody speaks, audio only fills the pre-roll buffer, so a turn starts with the
 * 300 ms before the detected speech and nothing is sent upstream in silence.
 * Push-to-talk skips the VAD: the UI says when the turn starts and ends.
 *
 * Everything except the audio libraries is injectable through `overrides`, which
 * the unit tests use.
 */

const STYLES = ['hands-free', 'push-to-talk'];
const AGENT_STATES = ['idle', 'thinking', 'speaking'];
// Audio kept from before the detected speech start.
const PRE_ROLL_MS = 300;
// Margin for the delay between the speech and the detector reporting it.
const PRE_ROLL_SLACK_MS = 64;
// The ring buffer holds enough for pre-roll plus the confirmation time.
const RING_CAPACITY_MS = 2000;
// Push-to-talk keeps listening this long after the key goes up, so the end of
// the last word is not cut off by the release.
const PTT_TAIL_MS = 150;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** A start-up failure the caller can show: `code` says what failed. */
function startError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/** `getUserMedia` failure to an error with a stable `code` (and the browser's `name`). */
function microphoneError(error) {
  let code = 'start-failed';
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      code = 'mic-denied';
      break;
    case 'NotFoundError':
    case 'OverconstrainedError':
      code = 'mic-missing';
      break;
    case 'NotReadableError':
    case 'AbortError':
      code = 'mic-busy';
      break;
    default:
      break;
  }
  const wrapped = startError(code, error?.message || 'The microphone is not available', error);
  if (error?.name) wrapped.name = error.name;
  return wrapped;
}

/** An AudioContext that captures at 16 kHz where the browser allows it. */
function createAudioContext(Ctor, at16k) {
  if (at16k) {
    try {
      return new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      /* the constructor rejects the option: use the native rate */
    }
  }
  return new Ctor();
}

function createAdapter({ service, modelId, language, listeningStyle, speech, emit, overrides }) {
  const custom = overrides.adapterOptions || {};
  switch (service) {
    case 'model':
      return createModelAdapter({ modelId, language, emit, ...custom });
    case 'azure':
      return createAzureAdapter({ language, speech, emit, ...custom });
    default:
      // `browser`, and `custom` (which has always used the browser).
      return createBrowserAdapter({ language, listeningStyle, emit, ...custom });
  }
}

/**
 * Start a voice session. Call it from the click that starts voice mode: the
 * browser asks for the microphone then, and the AudioContext can only be started
 * in a user gesture (iOS Safari).
 *
 * Resolves as soon as the microphone is open. The rest (loading the voice
 * activity detector, connecting to the speech service) finishes in the
 * background and is announced with the `ready` event; every setter is safe to
 * call before that.
 *
 * Rejects when the session cannot start at all: `error.code` is `mic-denied`,
 * `mic-missing`, `mic-busy`, `audio-unsupported`, `no-model` or `start-failed`.
 * Failures after that arrive as `error` events.
 *
 * Events (`onEvent`):
 *  - `{type:'ready'}`: the session listens
 *  - `{type:'level', level}`: microphone level 0..1, about 15 times a second
 *  - `{type:'speech-start'}`: the user started a turn
 *  - `{type:'barge-in'}`: the user started a turn while the app was speaking (and
 *    interruptions are on); replaces `speech-start` for that turn
 *  - `{type:'interim', text}`: the turn's text so far
 *  - `{type:'turn-end'}`: the turn is over (silence, or push-to-talk released)
 *  - `{type:'final', text}`: the turn's transcript (`''` if nothing was recognised)
 *  - `{type:'error', code, message, recoverable}`. `recoverable: false`: the
 *    session has been shut down (`closed` follows; start a new one). `recoverable:
 *    true`: the session lives on but captures nothing, as for `mic-lost` (tab hidden,
 *    microphone muted or unplugged); `setMuted(false)` resumes it if the microphone
 *    is back. Codes: `mic-lost`, `connection` (socket or network lost), `service` (the
 *    speech service refused or failed; `message` says why), `unsupported` (no Web
 *    Speech API), `mic-denied`, `mic-missing`, `vad-unavailable`.
 *  - `{type:'closed'}`: the session ended by itself (after an unrecoverable error).
 *    Not sent after `stop()`.
 *
 * @param {Object} options
 * @param {'model'|'azure'|'browser'} options.service - The app's speech service
 *   (`custom` is treated as `browser`).
 * @param {string} [options.modelId] - Transcription model, for `model`.
 * @param {string} [options.language] - UI language (`de`).
 * @param {'hands-free'|'push-to-talk'} [options.listeningStyle]
 * @param {boolean} [options.bargeIn] - Whether the user may interrupt the app by speaking.
 * @param {number} [options.endOfTurnSilenceMs] - Silence that ends a hands-free turn.
 * @param {object} [options.speech] - `platformConfig.speech` (Azure host and key state).
 * @param {(event: object) => void} options.onEvent
 * @param {Object} [options.overrides] - Tests: `createVad`, `createAdapter`,
 *   `getUserMedia`, `AudioContext`, `preRollMs`, `pttTailMs`, `now`, `assetBaseUrl`,
 *   `vad` (VAD parameters), `adapterOptions`.
 * @returns {Promise<{
 *   setAgentState: (state: 'idle'|'thinking'|'speaking') => void,
 *   setListeningStyle: (style: 'hands-free'|'push-to-talk') => void,
 *   setBargeIn: (value: boolean) => void,
 *   setMuted: (value: boolean) => void,
 *   pushToTalkStart: () => void,
 *   pushToTalkEnd: () => void,
 *   stop: () => void
 * }>}
 */
export async function createVoiceSession({
  service,
  modelId,
  language,
  listeningStyle = 'hands-free',
  bargeIn = true,
  endOfTurnSilenceMs = VAD_DEFAULTS.redemptionMs,
  speech,
  onEvent,
  overrides = {}
}) {
  if (service === 'model' && !modelId) {
    throw startError('no-model', 'No transcription model selected');
  }
  const AudioContextCtor =
    overrides.AudioContext ||
    (typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined);
  const getUserMedia =
    overrides.getUserMedia ||
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? constraints => navigator.mediaDevices.getUserMedia(constraints)
      : null);
  if (!AudioContextCtor) throw startError('audio-unsupported', 'Web Audio is not supported');
  if (!getUserMedia) throw startError('mic-denied', 'The microphone needs a secure connection');

  const now = overrides.now || (() => Date.now());
  const preRollMs = overrides.preRollMs ?? PRE_ROLL_MS;
  const pttTailMs = overrides.pttTailMs ?? PTT_TAIL_MS;
  const vadParams = { ...overrides.vad };

  // Created before the first await: that is still inside the click.
  let audioContext = createAudioContext(AudioContextCtor, true);
  audioContext.resume?.().catch(() => {});

  let stream;
  try {
    stream = await getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (error) {
    audioContext.close?.().catch(() => {});
    throw microphoneError(error);
  }

  // --- session state ---
  let stopped = false;
  let failed = false;
  let ready = false;
  let agentState = 'idle';
  let style = STYLES.includes(listeningStyle) ? listeningStyle : 'hands-free';
  let bargeInOn = Boolean(bargeIn);
  let muted = false;
  // Why nothing is captured although the user did not mute: 'hidden' | 'mic-lost'.
  let suspended = null;
  // The user turn in progress: { source: 'vad' | 'ptt', releasing: boolean }.
  let turn = null;
  let pttTimer = null;
  let setupTimer = null;
  let vad = null;
  let vadPromise = null;
  let capture = null;
  let adapter = null;

  const preRoll = createPreRollBuffer({ capacityMs: RING_CAPACITY_MS });

  const emit = event => {
    if (stopped) return;
    try {
      onEvent?.(event);
    } catch (error) {
      console.error('Voice session: event handler failed', error);
    }
  };

  const levelMeter = createLevelMeter({ onLevel: level => emit({ type: 'level', level }), now });

  const canListen = () => ready && !stopped && !muted && !suspended;

  // --- turns ---
  const beginTurn = (source, speechStartedAt) => {
    if (turn || !canListen()) return false;
    // Audio from before the detector was sure: the pre-roll, plus the time the
    // speech had already been going on when it was confirmed.
    const earlier = source === 'vad' && speechStartedAt ? Math.max(0, now() - speechStartedAt) : 0;
    const audio = preRoll.take(preRollMs + earlier + PRE_ROLL_SLACK_MS);
    turn = { source, releasing: false };
    adapter.beginTurn(audio, { source });
    return true;
  };

  const endTurn = () => {
    if (!turn) return;
    clearTimeout(pttTimer);
    pttTimer = null;
    turn = null;
    emit({ type: 'turn-end' });
    adapter.commitTurn();
  };

  const dropTurn = () => {
    if (!turn) return;
    clearTimeout(pttTimer);
    pttTimer = null;
    turn = null;
    adapter.cancelTurn();
  };

  // --- audio ---
  const onFrame = (frame, rate) => {
    if (stopped) return;
    if (muted || suspended) return;
    levelMeter.push(frame);
    const pcm = toPcm16At16k(frame, rate);
    if (turn) adapter?.pushAudio(pcm);
    else preRoll.push(pcm);
  };

  // --- voice activity detection (hands-free) ---
  const vadShouldRun = () => style === 'hands-free' && !muted && !suspended;

  const syncVad = () => {
    if (vad) void vad.setEnabled(vadShouldRun());
  };

  const ensureVad = () => {
    if (vad) return Promise.resolve(vad);
    if (vadPromise) return vadPromise;
    vadPromise = createVadController({
      createVad: overrides.createVad,
      stream,
      audioContext,
      assetBaseUrl: overrides.assetBaseUrl,
      redemptionMs: clamp(endOfTurnSilenceMs, 300, 3000),
      ...vadParams,
      agentSpeaking: agentState === 'speaking',
      bargeIn: bargeInOn,
      enabled: vadShouldRun(),
      now,
      onSpeechStart: ({ speechStartedAt }) => {
        if (style !== 'hands-free' || !beginTurn('vad', speechStartedAt)) return;
        emit({ type: 'speech-start' });
      },
      onBargeIn: ({ speechStartedAt }) => {
        if (style !== 'hands-free' || !beginTurn('vad', speechStartedAt)) return;
        emit({ type: 'barge-in' });
      },
      onSpeechEnd: () => {
        if (turn?.source === 'vad') endTurn();
      }
    }).then(
      controller => {
        if (stopped) {
          void controller.destroy();
          return null;
        }
        vad = controller;
        // The app's state may have changed while the detector loaded.
        controller.setAgentSpeaking(agentState === 'speaking');
        controller.setBargeIn(bargeInOn);
        void controller.setEnabled(vadShouldRun());
        return controller;
      },
      error => {
        vadPromise = null;
        throw startError('vad-unavailable', 'Voice detection could not be loaded', error);
      }
    );
    return vadPromise;
  };

  // --- failure and teardown ---
  const teardown = () => {
    clearTimeout(pttTimer);
    clearTimeout(setupTimer);
    document.removeEventListener?.('visibilitychange', onVisibilityChange);
    for (const track of stream.getAudioTracks()) {
      track.removeEventListener?.('ended', onTrackEnded);
      track.removeEventListener?.('mute', onTrackMuted);
    }
    if (audioContext) audioContext.onstatechange = null;
    try {
      adapter?.stop();
    } catch (error) {
      console.warn('Voice session: adapter stop failed', error);
    }
    if (vad) void vad.destroy();
    else vadPromise?.then(controller => controller?.destroy()).catch(() => {});
    capture?.stop();
    for (const track of stream.getTracks()) track.stop();
    if (audioContext && audioContext.state !== 'closed') audioContext.close?.().catch(() => {});
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    teardown();
  };

  // An unrecoverable failure: tell the caller, shut everything down, say so.
  const fail = (code, message) => {
    if (stopped || failed) return;
    failed = true;
    emit({ type: 'error', code, message, recoverable: false });
    stop();
    // `stop()` silenced the emitter; the caller still learns that the session is gone.
    try {
      onEvent?.({ type: 'closed' });
    } catch (error) {
      console.error('Voice session: event handler failed', error);
    }
  };

  // --- losing the microphone ---
  const suspend = reason => {
    if (suspended) return;
    suspended = reason;
    dropTurn();
    preRoll.clear();
    levelMeter.silence();
    syncVad();
  };

  const tracksLive = () =>
    stream.getAudioTracks().length > 0 &&
    stream.getAudioTracks().every(track => track.readyState === 'live');

  const microphoneLost = reason => {
    suspend(reason);
    emit({
      type: 'error',
      code: 'mic-lost',
      message: 'The microphone is not available',
      recoverable: true
    });
  };

  function onTrackEnded() {
    if (!stopped) microphoneLost('mic-lost');
  }

  function onTrackMuted() {
    // A hidden page is handled by the visibility change.
    if (!stopped && !document.hidden) microphoneLost('mic-lost');
  }

  // Never record in the background. The page being hidden suspends the capture at
  // once. Callers that react by muting the session (as voice mode does) are not
  // told of an error; for everyone else it is `mic-lost`, never a silent recording.
  function onVisibilityChange() {
    if (stopped) return;
    if (document.hidden) {
      if (suspended) return;
      suspend('hidden');
      setTimeout(() => {
        if (!stopped && suspended === 'hidden' && !muted) {
          emit({
            type: 'error',
            code: 'mic-lost',
            message: 'The page is in the background; the microphone was paused',
            recoverable: true
          });
        }
      }, 0);
    } else if (suspended === 'hidden' && muted) {
      // Back on the page; stays muted until the user unmutes.
      suspended = null;
      syncVad();
    }
  }

  const tryResume = () => {
    if (!suspended) return true;
    if (document.hidden || !tracksLive()) return false;
    suspended = null;
    if (audioContext.state === 'suspended') audioContext.resume?.().catch(() => {});
    return true;
  };

  // --- the session's adapter ---
  const adapterEmit = event => {
    if (event.type === 'error') fail(event.code || 'service', event.message || 'Speech error');
    else emit(event);
  };
  adapter = (overrides.createAdapter || createAdapter)({
    service,
    modelId,
    language,
    listeningStyle: style,
    speech,
    emit: adapterEmit,
    overrides
  });

  // --- audio graph ---
  const buildCapture = async () => {
    try {
      return await createCapture({ audioContext, stream, onFrame });
    } catch (error) {
      // Some engines refuse a 16 kHz context for a microphone at another rate.
      if (audioContext.sampleRate !== TARGET_SAMPLE_RATE) throw error;
      audioContext.close?.().catch(() => {});
      audioContext = createAudioContext(AudioContextCtor, false);
      audioContext.resume?.().catch(() => {});
      return createCapture({ audioContext, stream, onFrame });
    }
  };
  try {
    capture = await buildCapture();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    if (audioContext.state !== 'closed') audioContext.close?.().catch(() => {});
    throw startError('audio-unsupported', error?.message || 'Audio capture failed', error);
  }

  for (const track of stream.getAudioTracks()) {
    track.addEventListener?.('ended', onTrackEnded);
    track.addEventListener?.('mute', onTrackMuted);
  }
  document.addEventListener?.('visibilitychange', onVisibilityChange);
  audioContext.onstatechange = () => {
    // iOS interrupts the context (a call, Siri); take it back when possible.
    const { state } = audioContext;
    if (!stopped && !suspended && !document.hidden && state !== 'running' && state !== 'closed') {
      audioContext.resume?.().catch(() => {});
    }
  };

  // Finish setting up in the background: the caller has the session already, so
  // that it can stop it (and release the microphone) while this is going on.
  const setup = async () => {
    try {
      const tasks = [adapter.start()];
      if (style === 'hands-free') tasks.push(ensureVad());
      await Promise.all(tasks);
    } catch (error) {
      fail(error?.code || 'service', error?.message || 'The speech service is not available');
      return;
    }
    if (stopped) return;
    ready = true;
    emit({ type: 'ready' });
  };
  setupTimer = setTimeout(setup, 0);

  return {
    setAgentState(state) {
      if (stopped || !AGENT_STATES.includes(state)) return;
      agentState = state;
      vad?.setAgentSpeaking(state === 'speaking');
      adapter.setAgentState(state);
    },

    setListeningStyle(next) {
      if (stopped || !STYLES.includes(next) || next === style) return;
      // End the turn in progress properly before the way of ending turns changes.
      endTurn();
      style = next;
      adapter.setListeningStyle(next);
      if (next === 'hands-free') {
        ensureVad().then(
          () => syncVad(),
          error =>
            emit({
              type: 'error',
              code: error?.code || 'vad-unavailable',
              message: error?.message || 'Voice detection could not be loaded',
              recoverable: true
            })
        );
      } else {
        syncVad();
      }
    },

    setBargeIn(value) {
      bargeInOn = Boolean(value);
      vad?.setBargeIn(bargeInOn);
    },

    setMuted(value) {
      if (stopped) return;
      const next = Boolean(value);
      if (next) {
        muted = true;
        dropTurn();
        preRoll.clear();
        levelMeter.silence();
        adapter.setMuted(true);
        syncVad();
        return;
      }
      // Unmuting is also how a session that lost the microphone is brought back.
      if (!tryResume()) {
        microphoneLost(suspended || 'mic-lost');
        return;
      }
      muted = false;
      adapter.setMuted(false);
      syncVad();
    },

    pushToTalkStart() {
      if (style !== 'push-to-talk' || !canListen()) return;
      // Pressed again within the tail of the last turn: that turn ends now.
      if (turn?.releasing) endTurn();
      if (turn) return;
      const interrupting = agentState === 'speaking';
      if (interrupting && !bargeInOn) return;
      if (!beginTurn('ptt')) return;
      emit({ type: interrupting ? 'barge-in' : 'speech-start' });
    },

    pushToTalkEnd() {
      if (!turn || turn.source !== 'ptt' || turn.releasing) return;
      if (pttTailMs <= 0) {
        endTurn();
        return;
      }
      turn.releasing = true;
      pttTimer = setTimeout(() => {
        pttTimer = null;
        if (turn?.releasing) endTurn();
      }, pttTailMs);
    },

    stop
  };
}

export default createVoiceSession;
