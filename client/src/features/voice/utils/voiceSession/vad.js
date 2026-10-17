import { getVadAssetBaseUrl } from './vadAssets';

/**
 * Voice activity detection for hands-free turns.
 *
 * Two layers, so that everything but the audio library can be tested without
 * audio:
 *
 *  - `createSileroVad` wraps `@ricky0123/vad-web` (Silero VAD on ONNX Runtime
 *    Web). The library is imported on demand, so it never enters the main
 *    bundle, and runs on the session's own AudioContext and microphone stream.
 *    It is the "thin injectable `createVad` factory".
 *  - `createVadController` turns the raw detector events into the decisions the
 *    session needs: did a user turn start (or an interruption of the app), did it
 *    end, and with which thresholds. It takes any factory with the same shape.
 */

/**
 * Defaults, all overridable through the options of `createVoiceSession`.
 *  - `redemptionMs`: silence that ends the turn (the platform's `endOfTurnSilenceMs`)
 *  - `minSpeechMs`: shorter blips are ignored
 *  - `preSpeechPadMs`: audio kept before the detected start (the pre-roll)
 *  - `positiveSpeechThreshold`: Silero speech probability that counts as speech
 *  - `negativeSpeechThresholdOffset`: below `positive - offset` counts as silence
 *  - `bargeInMinSpeechMs`: speech needed to interrupt the app; longer than
 *    `minSpeechMs` so that the app's own voice leaking through the speakers does not
 *  - `bargeInThresholdBoost`: added to both thresholds while the app speaks
 */
export const VAD_DEFAULTS = Object.freeze({
  redemptionMs: 800,
  minSpeechMs: 250,
  preSpeechPadMs: 300,
  positiveSpeechThreshold: 0.5,
  negativeSpeechThresholdOffset: 0.15,
  bargeInMinSpeechMs: 350,
  bargeInThresholdBoost: 0.15,
  model: 'v5'
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The detector's thresholds and minimum speech length for a state of the app.
 * While the app speaks both thresholds rise by `bargeInThresholdBoost` and
 * `bargeInMinSpeechMs` replaces `minSpeechMs`.
 *
 * @returns {{ positiveSpeechThreshold: number, negativeSpeechThreshold: number, minSpeechMs: number }}
 */
export function vadThresholds({
  speaking,
  positiveSpeechThreshold = VAD_DEFAULTS.positiveSpeechThreshold,
  negativeSpeechThresholdOffset = VAD_DEFAULTS.negativeSpeechThresholdOffset,
  minSpeechMs = VAD_DEFAULTS.minSpeechMs,
  bargeInMinSpeechMs = VAD_DEFAULTS.bargeInMinSpeechMs,
  bargeInThresholdBoost = VAD_DEFAULTS.bargeInThresholdBoost
}) {
  const boost = speaking ? bargeInThresholdBoost : 0;
  const positive = clamp(positiveSpeechThreshold + boost, 0.05, 0.95);
  const negative = clamp(positive - negativeSpeechThresholdOffset, 0.01, positive - 0.01);
  return {
    positiveSpeechThreshold: Math.round(positive * 1000) / 1000,
    negativeSpeechThreshold: Math.round(negative * 1000) / 1000,
    minSpeechMs: speaking ? Math.max(minSpeechMs, bargeInMinSpeechMs) : minSpeechMs
  };
}

/**
 * Silero VAD on the session's microphone stream and AudioContext.
 *
 * @param {Object} options
 * @param {MediaStream} options.stream - The session's one echo-cancelled stream.
 * @param {AudioContext} options.audioContext - The session's context (iOS Safari
 *   only allows one that was created in the click).
 * @param {string} [options.assetBaseUrl] - Where `/vad/` is served; default: `getVadAssetBaseUrl()`.
 * @param {number} options.positiveSpeechThreshold
 * @param {number} options.negativeSpeechThreshold
 * @param {number} options.redemptionMs
 * @param {number} options.minSpeechMs
 * @param {number} options.preSpeechPadMs
 * @param {() => void} options.onSpeechStart - First frame above the threshold.
 * @param {() => void} options.onSpeechRealStart - Speech lasted `minSpeechMs`.
 * @param {() => void} options.onSpeechEnd - `redemptionMs` of silence after speech.
 * @param {() => void} options.onMisfire - A blip shorter than `minSpeechMs` ended.
 * @returns {Promise<{ setOptions: Function, start: () => Promise<void>,
 *   pause: () => Promise<void>, destroy: () => Promise<void> }>}
 */
export async function createSileroVad({
  stream,
  audioContext,
  assetBaseUrl = getVadAssetBaseUrl(),
  model = VAD_DEFAULTS.model,
  positiveSpeechThreshold,
  negativeSpeechThreshold,
  redemptionMs,
  minSpeechMs,
  preSpeechPadMs,
  onSpeechStart,
  onSpeechRealStart,
  onSpeechEnd,
  onMisfire
}) {
  // Lazy: ONNX Runtime and the library stay out of the main bundle.
  const { MicVAD } = await import('@ricky0123/vad-web');
  const micVad = await MicVAD.new({
    model,
    audioContext,
    // The session owns the stream: the library must neither open another
    // microphone nor stop ours when it pauses.
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    baseAssetPath: assetBaseUrl,
    onnxWASMBasePath: assetBaseUrl,
    positiveSpeechThreshold,
    negativeSpeechThreshold,
    redemptionMs,
    minSpeechMs,
    preSpeechPadMs,
    submitUserSpeechOnPause: false,
    // One thread: no SharedArrayBuffer (and so no cross-origin isolation
    // headers) needed, and Silero is far too small to profit from more.
    ortConfig: ort => {
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
    },
    onSpeechStart: () => onSpeechStart?.(),
    onSpeechRealStart: () => onSpeechRealStart?.(),
    onSpeechEnd: () => onSpeechEnd?.(),
    onVADMisfire: () => onMisfire?.()
  });
  return {
    setOptions: update => micVad.setOptions(update),
    start: () => micVad.start(),
    pause: () => micVad.pause(),
    destroy: () => micVad.destroy()
  };
}

/**
 * Detector events to session decisions.
 *
 * - `onSpeechStart` fires when speech is *confirmed* (`minSpeechMs`, or
 *   `bargeInMinSpeechMs` while the app speaks), with the time the speech really
 *   began, so the session can hand the speech service the audio from before.
 * - While the app speaks and interruptions are on, confirmed speech calls
 *   `onBargeIn` instead of `onSpeechStart`. With interruptions off the utterance
 *   is ignored altogether, also if the app falls silent while it goes on.
 * - The same holds while the app is merely busy (thinking: the answer is being
 *   written): with interruptions off nothing the user says may start a turn, or
 *   its transcript would be dropped by the state machine while the turn itself
 *   disturbed the one in progress. With interruptions on a turn started then is an
 *   ordinary `onSpeechStart` (the caller decides what speaking while it thinks means).
 * - `onSpeechEnd` fires once per utterance that started a turn.
 *
 * @param {Object} options
 * @param {(options: object) => Promise<object>} [options.createVad] - The
 *   detector factory (`createSileroVad`); tests inject a fake.
 * @param {MediaStream} [options.stream]
 * @param {AudioContext} [options.audioContext]
 * @param {string} [options.assetBaseUrl]
 * @param {number} [options.redemptionMs]
 * @param {number} [options.minSpeechMs]
 * @param {number} [options.preSpeechPadMs]
 * @param {number} [options.positiveSpeechThreshold]
 * @param {number} [options.bargeInMinSpeechMs]
 * @param {number} [options.bargeInThresholdBoost]
 * @param {boolean} [options.agentSpeaking] - Initial state.
 * @param {boolean} [options.agentBusy] - Initial state: the app thinks or speaks.
 * @param {boolean} [options.bargeIn] - Initial state.
 * @param {boolean} [options.enabled] - Initial state; disabled pauses the detector.
 * @param {() => number} [options.now]
 * @param {(info: { speechStartedAt: number }) => void} options.onSpeechStart
 * @param {(info: { speechStartedAt: number }) => void} options.onBargeIn
 * @param {() => void} options.onSpeechEnd
 */
export async function createVadController({
  createVad = createSileroVad,
  stream,
  audioContext,
  assetBaseUrl,
  redemptionMs = VAD_DEFAULTS.redemptionMs,
  minSpeechMs = VAD_DEFAULTS.minSpeechMs,
  preSpeechPadMs = VAD_DEFAULTS.preSpeechPadMs,
  positiveSpeechThreshold = VAD_DEFAULTS.positiveSpeechThreshold,
  bargeInMinSpeechMs = VAD_DEFAULTS.bargeInMinSpeechMs,
  bargeInThresholdBoost = VAD_DEFAULTS.bargeInThresholdBoost,
  agentSpeaking = false,
  agentBusy = false,
  bargeIn = true,
  enabled = true,
  now = () => Date.now(),
  onSpeechStart,
  onBargeIn,
  onSpeechEnd
}) {
  let speaking = agentSpeaking;
  let busy = agentBusy;
  let bargeInOn = bargeIn;
  let active = enabled;
  let destroyed = false;
  // When the detector first saw speech in the current utterance.
  let rawStartedAt = 0;
  // What the current utterance is: a user turn, one to ignore, or not decided.
  let utterance = null;

  const thresholds = () =>
    vadThresholds({
      speaking,
      positiveSpeechThreshold,
      minSpeechMs,
      bargeInMinSpeechMs,
      bargeInThresholdBoost
    });

  const decide = () => {
    if (utterance || destroyed) return;
    if (!active) {
      utterance = 'ignored';
    } else if ((speaking || busy) && !bargeInOn) {
      utterance = 'ignored';
    } else if (speaking) {
      utterance = 'turn';
      onBargeIn?.({ speechStartedAt: rawStartedAt });
    } else {
      utterance = 'turn';
      onSpeechStart?.({ speechStartedAt: rawStartedAt });
    }
  };

  const endUtterance = () => {
    const wasTurn = utterance === 'turn';
    utterance = null;
    if (wasTurn && !destroyed) onSpeechEnd?.();
  };

  const initial = thresholds();
  const vad = await createVad({
    stream,
    audioContext,
    assetBaseUrl,
    redemptionMs,
    preSpeechPadMs,
    ...initial,
    onSpeechStart: () => {
      if (destroyed) return;
      rawStartedAt = now();
      utterance = null;
    },
    onSpeechRealStart: () => decide(),
    onSpeechEnd: () => {
      // The detector skips its "real start" when `minSpeechMs` changed while
      // the utterance ran (the app started or stopped speaking): decide now.
      decide();
      endUtterance();
    },
    onMisfire: () => {
      // Normally a blip that never became a turn. If the minimum was raised
      // after the turn had started, the detector calls the same utterance a
      // blip: it still has to end.
      endUtterance();
    }
  });

  const safely = async (fn, what) => {
    try {
      await fn();
    } catch (err) {
      console.warn(`Voice VAD: ${what} failed`, err);
    }
  };

  const applyOptions = () => safely(() => vad.setOptions(thresholds()), 'setOptions');

  if (!active) await safely(() => vad.pause(), 'pause');

  return {
    /** The app starts or stops speaking: raise or lower the thresholds. */
    setAgentSpeaking(value) {
      const next = Boolean(value);
      if (next === speaking) return;
      speaking = next;
      void applyOptions();
    },

    /**
     * The app starts or stops working on an answer (thinking or speaking). Only
     * matters with interruptions off: then no utterance starts a turn meanwhile.
     */
    setAgentBusy(value) {
      busy = Boolean(value);
    },

    setBargeIn(value) {
      bargeInOn = Boolean(value);
    },

    /** Run (true) or pause (false) the detector; a pause drops an utterance in progress. */
    async setEnabled(value) {
      const next = Boolean(value);
      if (next === active || destroyed) return;
      active = next;
      utterance = null;
      await safely(() => (active ? vad.start() : vad.pause()), active ? 'start' : 'pause');
    },

    /** Whether a user turn is in progress according to the detector. */
    isTurnActive() {
      return utterance === 'turn';
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
      utterance = null;
      await safely(() => vad.destroy(), 'destroy');
    }
  };
}
