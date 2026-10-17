import { toRecognitionLang } from '../speechService';

/**
 * Voice session adapter for the `browser` speech service: the Web Speech API
 * (`SpeechRecognition`, `webkitSpeechRecognition`), in continuous mode with
 * interim results for the live caption.
 *
 * The API opens a microphone of its own and cannot take the session's stream, so
 * it hears the room, echo cancelled or not, as the browser decides. What this
 * adapter controls is when it listens and when a turn ends:
 *
 *  - The session's VAD (on the echo-cancelled stream) decides when the turn is
 *    over; the adapter then calls `recognition.stop()` and the result that
 *    follows is the turn's final transcript.
 *  - Hands-free: the recognizer runs while the app is not speaking and is paused
 *    (aborted) while it speaks, so the app's own voice stays out of the
 *    transcript. When the user interrupts, or the app falls silent, it starts
 *    again. The first fraction of a second of an interruption is lost, because
 *    pre-roll audio cannot be replayed into the browser recognizer.
 *  - Push-to-talk: the recognizer only runs while the key is held (it does not
 *    listen in between, which would send ambient speech to the browser vendor).
 *  - Chrome ends a continuous recognition on its own now and then (silence,
 *    network blips): while it should be listening, the adapter starts it again.
 *    Text of the turn collected so far is kept.
 */

const FINALIZE_TIMEOUT_MS = 1500;
const RESTART_DELAY_MS = 120;
const MAX_FAILURES = 3;
// An instance that ends this fast without a result did not really run.
const MIN_HEALTHY_RUN_MS = 500;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const joinText = (...parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

/** The recognizer constructor of this browser, if any. */
export function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

/**
 * @param {Object} options
 * @param {string} [options.language] - UI language (`de`) or locale (`de-DE`).
 * @param {'hands-free'|'push-to-talk'} [options.listeningStyle]
 * @param {(event: object) => void} options.emit
 * @param {() => Function|undefined} [options.getRecognitionCtor]
 * @param {number} [options.finalizeTimeoutMs] - How long to wait for the result after `stop()`.
 * @param {number} [options.restartDelayMs]
 * @param {() => number} [options.now]
 */
export function createBrowserAdapter({
  language,
  listeningStyle = 'hands-free',
  emit,
  getRecognitionCtor = getSpeechRecognitionCtor,
  finalizeTimeoutMs = FINALIZE_TIMEOUT_MS,
  restartDelayMs = RESTART_DELAY_MS,
  now = () => Date.now()
}) {
  let started = false;
  let stopped = false;
  let failed = false;
  let muted = false;
  let agentState = 'idle';
  let style = listeningStyle;
  // The running recognition, and its bookkeeping.
  let instance = null;
  // The user turn in progress: { carry, text, committed, timer }
  let turn = null;
  // The user started speaking again while the previous turn was still being finalized.
  let queuedTurn = false;
  let restartTimer = null;
  let failures = 0;

  const fail = (code, message) => {
    if (stopped || failed) return;
    failed = true;
    clearTimeout(restartTimer);
    restartTimer = null;
    emit({ type: 'error', code, message, recoverable: false });
  };

  const wantRunning = () => {
    if (!started || stopped || failed || muted) return false;
    if (turn) return true;
    if (style === 'push-to-talk') return false;
    return agentState !== 'speaking';
  };

  const abortInstance = () => {
    if (!instance || instance.stopping) return;
    instance.stopping = true;
    try {
      instance.rec.abort();
    } catch {
      /* already ended */
    }
  };

  const publishInterim = () => {
    if (turn && !turn.discard && turn.text) emit({ type: 'interim', text: turn.text });
  };

  // Rebuild the turn's text from the recognition's results: the finals and the
  // interim tail from `skip` on (earlier ones belong to speech before the turn).
  const readResults = (record, results) => {
    let finalCount = 0;
    const parts = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].isFinal) finalCount = i + 1;
      if (i >= record.skip) parts.push(results[i][0]?.transcript || '');
    }
    record.finalCount = finalCount;
    return joinText(...parts);
  };

  const startInstance = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      fail('unsupported', 'Speech recognition is not supported in this browser');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = toRecognitionLang(language);
    rec.maxAlternatives = 1;
    const record = {
      rec,
      skip: 0,
      finalCount: 0,
      lastResults: null,
      dead: false,
      stopping: false,
      finalizing: false,
      gotResult: false,
      startedAt: now()
    };
    instance = record;
    rec.onresult = event => {
      if (record !== instance) return;
      record.gotResult = true;
      record.lastResults = event.results;
      failures = 0;
      const text = readResults(record, event.results);
      if (!turn || turn.discard) return;
      turn.text = joinText(turn.carry, text);
      publishInterim();
    };
    rec.onerror = event => handleError(record, event);
    rec.onend = () => handleEnd(record);
    try {
      rec.start();
    } catch (err) {
      // `start()` throws when a recognition is still running.
      instance = null;
      noteFailure(err?.message);
    }
  };

  function noteFailure(message, code = 'service') {
    failures += 1;
    if (failures >= MAX_FAILURES) {
      fail(code, message || 'Speech recognition keeps stopping');
    }
  }

  function handleError(record, event) {
    if (record !== instance || stopped) return;
    switch (event?.error) {
      case 'no-speech':
      case 'aborted':
        // Normal life of a continuous recognition; `onend` follows.
        break;
      case 'not-allowed':
      case 'service-not-allowed':
        fail('mic-denied', 'Microphone or speech recognition access was denied');
        break;
      case 'language-not-supported':
        fail('unsupported', 'This language is not supported by the browser recognizer');
        break;
      case 'audio-capture':
        fail('mic-missing', 'No microphone found');
        break;
      case 'network':
        noteFailure('The browser could not reach its speech recognition service', 'connection');
        break;
      default:
        noteFailure(event?.message || event?.error);
        break;
    }
  }

  function handleEnd(record) {
    if (record === instance) instance = null;
    if (stopped || failed || record.dead) return;
    if (record.finalizing && turn?.committed) {
      finishTurn();
      return;
    }
    if (turn && !turn.committed) {
      // The recognition ended under a turn in progress (Chrome's own timeout):
      // keep what was heard, the next recognition continues the turn.
      turn.carry = turn.text;
    }
    if (!record.gotResult && now() - record.startedAt < MIN_HEALTHY_RUN_MS && !record.stopping) {
      noteFailure('Speech recognition ended right after it started');
    }
    scheduleSync();
  }

  function finishTurn() {
    if (!turn) return;
    clearTimeout(turn.timer);
    const finished = turn;
    turn = null;
    if (!finished.discard) emit({ type: 'final', text: finished.text.trim() });
    if (queuedTurn) {
      queuedTurn = false;
      turn = { carry: '', text: '', committed: false, timer: null, discard: false };
    }
    scheduleSync();
  }

  function sync() {
    if (wantRunning()) {
      if (!instance) startInstance();
    } else {
      abortInstance();
    }
  }

  // Start again shortly, not in the same tick as the end of the last recognition.
  function scheduleSync() {
    if (stopped || failed || restartTimer) return;
    if (!wantRunning()) {
      abortInstance();
      return;
    }
    if (instance) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      sync();
    }, restartDelayMs);
  }

  return {
    /** Check that the browser has the API and start listening (hands-free). */
    async start() {
      if (!getRecognitionCtor()) {
        throw sessionError('unsupported', 'Speech recognition is not supported in this browser');
      }
      started = true;
      sync();
    },

    /** Speech was confirmed (or the push-to-talk key went down). */
    beginTurn() {
      if (stopped || failed || muted) return;
      if (turn) {
        // The last turn is still being finalized: this one follows it.
        if (turn.committed) queuedTurn = true;
        return;
      }
      turn = { carry: '', text: '', committed: false, timer: null, discard: false };
      if (instance && !instance.stopping) {
        // Whatever the recognizer finished before this moment is not this turn;
        // what it is hearing right now (the start of the sentence) is.
        instance.skip = instance.finalCount;
        if (instance.lastResults) {
          turn.text = readResults(instance, instance.lastResults);
          publishInterim();
        }
      }
      sync();
    },

    // The recognizer listens on its own; there is no audio to push.
    pushAudio() {},

    /** The turn is over: stop the recognizer, its last result is the final transcript. */
    commitTurn() {
      if (!turn || turn.committed) return;
      turn.committed = true;
      const record = instance;
      if (!record || record.stopping) {
        finishTurn();
        return;
      }
      record.stopping = true;
      record.finalizing = true;
      turn.timer = setTimeout(() => {
        // The browser never delivered its last result: use what there is.
        record.dead = true;
        if (instance === record) instance = null;
        try {
          record.rec.abort();
        } catch {
          /* ignore */
        }
        finishTurn();
      }, finalizeTimeoutMs);
      try {
        record.rec.stop();
      } catch {
        clearTimeout(turn.timer);
        record.dead = true;
        instance = null;
        finishTurn();
      }
    },

    cancelTurn() {
      if (!turn) return;
      clearTimeout(turn.timer);
      turn = null;
      queuedTurn = false;
      abortInstance();
      scheduleSync();
    },

    /** Paused while the app speaks, running again when it stops. */
    setAgentState(state) {
      agentState = state;
      sync();
    },

    setMuted(value) {
      muted = Boolean(value);
      if (muted) {
        clearTimeout(turn?.timer);
        turn = null;
        queuedTurn = false;
      }
      sync();
    },

    setListeningStyle(value) {
      style = value;
      sync();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(restartTimer);
      clearTimeout(turn?.timer);
      restartTimer = null;
      turn = null;
      if (instance) {
        const { rec } = instance;
        instance.stopping = true;
        instance = null;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
    }
  };
}
