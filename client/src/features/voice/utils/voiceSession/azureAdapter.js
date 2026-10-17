import { buildApiUrl } from '../../../../utils/runtimeBasePath';
import { pcmToArrayBuffer, TARGET_SAMPLE_RATE } from './audioUtils';
import { toRecognitionLang } from '../speechService';

/**
 * Voice session adapter for the `azure` speech service: the Azure Speech SDK in
 * the browser, fed with the session's own audio instead of the default
 * microphone, so it hears the echo-cancelled stream and only what the voice
 * activity detector lets through.
 *
 * One recognizer per user turn. The SDK's push stream cannot be reopened once it
 * is closed, and closing it is what makes a turn end deterministically: the
 * service gets the end of the audio, delivers the last phrases and the SDK ends
 * the session, with no guessing how long to wait for trailing silence. A turn
 * therefore runs like this:
 *
 *   speech confirmed   new push stream, pre-roll written, recognizer built and
 *                      started (the connection to Azure opens while the user is
 *                      still talking; audio written meanwhile is buffered)
 *   audio frames       written to the push stream
 *   `recognizing`      interim caption
 *   turn ends          the push stream is closed; the recognizer's phrases up to
 *                      the end of the stream are the turn's final transcript
 *
 * What makes this cheap is that nothing waits on the token: it comes from
 * `GET /api/voice/azure/token` once when the session starts and is refreshed
 * before it expires (Azure tokens last 10 minutes). Without a subscription key on
 * the server (an on-premise Azure Speech container) no token is requested and
 * the recognizer connects to the configured host directly, as
 * `azureRecognitionService.js` does.
 */

// Azure authorization tokens are valid for 10 minutes: renew after 8.
const TOKEN_MAX_AGE_MS = 8 * 60_000;
// How long to wait for the SDK to finish a turn after its audio ended.
const FINALIZE_TIMEOUT_MS = 5000;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const joinText = (...parts) =>
  parts
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

// `import()` of the CommonJS-style SDK: named exports on the namespace or on `default`.
const resolveSdk = mod => (mod?.SpeechRecognizer ? mod : mod?.default || mod);

/**
 * @param {Object} options
 * @param {string} [options.language] - UI language (`de`) or locale (`de-DE`).
 * @param {object} [options.speech] - `platformConfig.speech` (`azure.enabled`,
 *   `azure.keyConfigured`, `azure.host`).
 * @param {(event: object) => void} options.emit
 * @param {() => Promise<object>} [options.loadSdk] - Tests inject a mocked SDK.
 * @param {() => Promise<{ token: string|null, region: string }>} [options.fetchToken]
 * @param {number} [options.finalizeTimeoutMs]
 * @param {number} [options.tokenMaxAgeMs]
 * @param {() => number} [options.now]
 */
export function createAzureAdapter({
  language,
  speech,
  emit,
  loadSdk = () => import('microsoft-cognitiveservices-speech-sdk'),
  fetchToken,
  finalizeTimeoutMs = FINALIZE_TIMEOUT_MS,
  tokenMaxAgeMs = TOKEN_MAX_AGE_MS,
  now = () => Date.now()
}) {
  const host = speech?.azure?.host || '';
  // Only ask the server for a token when it holds a subscription key.
  const useServerToken = Boolean(speech?.azure?.enabled && speech?.azure?.keyConfigured);

  let sdk = null;
  let stopped = false;
  let failed = false;
  let muted = false;
  let auth = null; // { token, region, at }
  let authPromise = null;
  // The turn that receives audio, and the ones that are being finalized.
  let active = null;
  const finishing = new Set();

  const requestToken =
    fetchToken ||
    (async () => {
      const res = await fetch(buildApiUrl('/voice/azure/token'), { credentials: 'include' });
      if (!res.ok) {
        let message = `Azure token request failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }
      return res.json(); // { token, region }
    });

  // The token for the next recognizer; one request at a time, cached until stale.
  const getAuth = () => {
    if (!useServerToken) return Promise.resolve({ token: null, region: '' });
    if (auth && now() - auth.at < tokenMaxAgeMs) return Promise.resolve(auth);
    if (!authPromise) {
      authPromise = requestToken()
        .then(({ token, region }) => {
          auth = { token, region, at: now() };
          return auth;
        })
        .finally(() => {
          authPromise = null;
        });
    }
    return authPromise;
  };

  const buildSpeechConfig = ({ token, region }) => {
    let config;
    if (host) {
      // A custom host (private endpoint, on-premise container) wins over the region.
      const url = new URL(`${host}/speech/recognition/interactive/cognitiveservices/v1`);
      config = sdk.SpeechConfig.fromHost(url);
      if (token) config.authorizationToken = token;
    } else if (token) {
      config = sdk.SpeechConfig.fromAuthorizationToken(token, region);
    } else {
      throw sessionError('service', 'Azure subscription key is not configured');
    }
    config.speechRecognitionLanguage = toRecognitionLang(language);
    return config;
  };

  const fail = (code, message) => {
    if (stopped || failed) return;
    failed = true;
    emit({ type: 'error', code, message, recoverable: false });
  };

  const textOf = turn => joinText(...turn.segments, turn.hypothesis);

  const publishInterim = turn => {
    if (stopped || turn.done || turn.discard) return;
    const text = textOf(turn);
    if (text) emit({ type: 'interim', text });
  };

  const releaseRecognizer = turn => {
    const { recognizer } = turn;
    turn.recognizer = null;
    if (!recognizer) return;
    const close = () => {
      try {
        recognizer.close();
      } catch {
        /* already closed */
      }
    };
    try {
      recognizer.stopContinuousRecognitionAsync(close, close);
    } catch {
      close();
    }
  };

  // The turn's transcript is complete (or will not come): hand it on, free the SDK.
  const finalize = turn => {
    if (turn.done) return;
    turn.done = true;
    clearTimeout(turn.timer);
    finishing.delete(turn);
    if (active === turn) active = null;
    try {
      turn.pushStream.close();
    } catch {
      /* already closed */
    }
    releaseRecognizer(turn);
    if (!turn.discard && !stopped) emit({ type: 'final', text: textOf(turn) });
  };

  const turnFailed = (turn, error) => {
    const detail = typeof error === 'string' ? error : error?.message;
    turn.discard = true;
    finalize(turn);
    fail(error?.code || 'service', detail || 'Azure speech recognition failed');
  };

  const classifyCancellation = event => {
    switch (event.errorCode) {
      case sdk.CancellationErrorCode.ServiceTimeout:
      case sdk.CancellationErrorCode.ConnectionFailure:
        return 'network';
      default:
        return 'service';
    }
  };

  const openRecognizer = async turn => {
    try {
      const credentials = await getAuth();
      // Cancelled or finished while the token was on its way.
      if (turn.done || stopped) return;
      const speechConfig = buildSpeechConfig(credentials);
      const audioConfig = sdk.AudioConfig.fromStreamInput(turn.pushStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      turn.recognizer = recognizer;

      recognizer.recognizing = (_sender, event) => {
        if (turn.done || event.result.reason !== sdk.ResultReason.RecognizingSpeech) return;
        turn.hypothesis = event.result.text || '';
        publishInterim(turn);
      };
      recognizer.recognized = (_sender, event) => {
        if (turn.done) return;
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text) {
          turn.segments.push(event.result.text);
        }
        // A phrase is final, or nothing matched: the hypothesis is settled.
        turn.hypothesis = '';
        publishInterim(turn);
      };
      recognizer.canceled = (_sender, event) => {
        if (turn.done) return;
        if (event.reason === sdk.CancellationReason.Error) {
          turnFailed(
            turn,
            sessionError(classifyCancellation(event), event.errorDetails || 'Azure recognition failed')
          );
          return;
        }
        // End of the audio stream: the turn is over.
        turn.ended = true;
        if (turn.committed) finalize(turn);
      };
      recognizer.sessionStopped = () => {
        if (turn.done) return;
        turn.ended = true;
        if (turn.committed) finalize(turn);
      };

      recognizer.startContinuousRecognitionAsync(
        () => {},
        err => turnFailed(turn, err)
      );
    } catch (err) {
      turnFailed(turn, err);
    }
  };

  return {
    /** Load the SDK and fetch the first token, so the first turn starts at once. */
    async start() {
      try {
        sdk = resolveSdk(await loadSdk());
        await getAuth();
      } catch (err) {
        throw sessionError(err?.code || 'service', err?.message || 'Azure Speech is unavailable');
      }
    },

    /** Speech was confirmed: open a recognizer for this turn, feed it the pre-roll. */
    beginTurn(preRoll) {
      if (stopped || failed || muted || !sdk || active) return;
      const pushStream = sdk.AudioInputStream.createPushStream(
        sdk.AudioStreamFormat.getWaveFormatPCM(TARGET_SAMPLE_RATE, 16, 1)
      );
      const turn = {
        pushStream,
        recognizer: null,
        segments: [],
        hypothesis: '',
        committed: false,
        ended: false,
        done: false,
        discard: false,
        timer: null
      };
      active = turn;
      if (preRoll?.length) pushStream.write(pcmToArrayBuffer(preRoll));
      void openRecognizer(turn);
    },

    pushAudio(pcm) {
      if (!active || muted || stopped || !pcm?.length) return;
      active.pushStream.write(pcmToArrayBuffer(pcm));
    },

    /** The turn is over: end the audio, the SDK delivers what is left, then `final`. */
    commitTurn() {
      const turn = active;
      if (!turn) return;
      active = null;
      turn.committed = true;
      finishing.add(turn);
      turn.pushStream.close();
      if (turn.ended) {
        finalize(turn);
        return;
      }
      turn.timer = setTimeout(() => finalize(turn), finalizeTimeoutMs);
    },

    /** Dropped (muted mid-sentence): no transcript. */
    cancelTurn() {
      const turn = active;
      if (!turn) return;
      active = null;
      turn.discard = true;
      finalize(turn);
    },

    setAgentState() {},
    setListeningStyle() {},

    setMuted(value) {
      muted = Boolean(value);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      for (const turn of [active, ...finishing]) {
        if (!turn) continue;
        turn.discard = true;
        finalize(turn);
      }
      active = null;
      finishing.clear();
    }
  };
}
