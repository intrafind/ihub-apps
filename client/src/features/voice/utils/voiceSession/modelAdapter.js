import { buildWsUrl } from '../../../../utils/runtimeBasePath';
import { pcmToArrayBuffer } from './audioUtils';
import { toRecognitionLang } from '../speechService';

/**
 * Voice session adapter for the `model` speech service: a transcription model
 * behind iHub's `/api/voice/realtime` WebSocket (same URL, cookie
 * authentication and base path as `modelRecognitionService.js`), in the
 * multi-turn "conversation" mode of that bridge:
 *
 *   start {modelId, lang, conversation: true}  ->  ready
 *   PCM16 16 kHz binary frames                 ->  delta {text}*   (streaming models)
 *   commit  (end of one user turn)             ->  final {text, turn}
 *   keepalive (every 15 s, the whole session)
 *   stop
 *
 * Audio only goes up while the user speaks (the session hands the adapter the
 * pre-roll when a turn starts, then each frame until it ends), so a GPU-backed
 * model is not fed the silence while the app talks. `final` frames carry the
 * number of the turn (the n-th `commit` of the socket): a final of a turn that
 * nobody waits for is ignored.
 *
 * An unexpected close is answered with one reconnect (a fresh `start`). The
 * budget is per outage: once the new socket is `ready` it is whole again, so a
 * long conversation survives any number of separate drops. A drop while the
 * socket is not yet back (or the new socket closing before `ready`) fails the
 * session with an unrecoverable error.
 *
 * A turn that was being spoken when the socket dropped lost its beginning (the
 * audio went to the dead socket). Its end alone would be transcribed as a
 * truncated sentence, so that turn is discarded: it ends with an empty `final`
 * and the user says it again.
 */

/** The server's idle timeout is 60 s; it asks for a keepalive at least every 20 s. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** Above this many queued bytes (about 8 s of audio) frames are dropped, not queued. */
export const MAX_BUFFERED_BYTES = 256 * 1024;
const READY_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 250;
const OPEN = 1; // WebSocket.OPEN, also on fakes

// Close codes that are an answer, not a failure of the network: policy
// violation (not signed in, origin refused), unsupported data, message too big,
// and the application range.
const isRefusalClose = code => code === 1008 || code === 1003 || code === 1009 || code >= 4000;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {Object} options
 * @param {string} options.modelId - Transcription model.
 * @param {string} [options.language] - UI language (`de`) or locale (`de-DE`).
 * @param {(event: object) => void} options.emit - Session events (`interim`, `final`, `error`).
 * @param {(url: string) => WebSocket} [options.createWebSocket] - Tests inject a fake.
 * @param {() => string} [options.getUrl]
 * @param {number} [options.keepaliveMs]
 * @param {number} [options.maxBufferedBytes]
 * @param {number} [options.readyTimeoutMs]
 * @param {number} [options.reconnectDelayMs]
 */
export function createModelAdapter({
  modelId,
  language,
  emit,
  createWebSocket = url => new WebSocket(url),
  getUrl = () => buildWsUrl('/voice/realtime'),
  keepaliveMs = KEEPALIVE_INTERVAL_MS,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
  readyTimeoutMs = READY_TIMEOUT_MS,
  reconnectDelayMs = RECONNECT_DELAY_MS
}) {
  let ws = null;
  let stopped = false;
  let failed = false;
  let reconnects = 0;
  let keepaliveTimer = null;
  let reconnectTimer = null;
  let readyTimer = null;
  let startSettled = false;
  let resolveStart = null;
  let rejectStart = null;
  let muted = false;
  // Is audio flowing to the socket for a user turn right now?
  let turnOpen = false;
  // The open turn lost audio to a socket that dropped: do not send what is left of it.
  let turnTruncated = false;
  // Commits sent on the current socket (the server counts them the same way)
  // and the ones whose `final` is still awaited, oldest first. `discard`: the
  // user dropped the turn (muted mid-sentence), so its answer is not wanted.
  let committed = 0;
  let pending = [];
  let interimText = '';
  let sawServerError = false;
  let droppedFrames = 0;

  const isOpen = () => Boolean(ws) && ws.readyState === OPEN;

  const sendJson = payload => {
    if (!isOpen()) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const sendAudio = pcm => {
    if (!pcm?.length) return;
    if (!isOpen()) {
      // Speech while the socket is down (or not yet back): that audio is gone.
      if (turnOpen) turnTruncated = true;
      return;
    }
    if (ws.bufferedAmount > maxBufferedBytes) {
      // The link cannot keep up: drop instead of queueing seconds of audio.
      droppedFrames += 1;
      if (droppedFrames === 1) console.warn('Voice session: socket backed up, dropping audio');
      return;
    }
    try {
      ws.send(pcmToArrayBuffer(pcm));
    } catch {
      /* the close handler deals with a dead socket */
    }
  };

  const clearTimers = () => {
    clearInterval(keepaliveTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(readyTimer);
    keepaliveTimer = null;
    reconnectTimer = null;
    readyTimer = null;
  };

  const settleStart = error => {
    if (startSettled) return;
    startSettled = true;
    clearTimeout(readyTimer);
    readyTimer = null;
    if (error) rejectStart?.(error);
    else resolveStart?.();
  };

  // Report a failure once: as the rejection of `start()` while the session is
  // coming up, as an unrecoverable `error` event afterwards.
  const fail = (code, message) => {
    if (stopped || failed) return;
    failed = true;
    clearTimers();
    if (!startSettled) settleStart(sessionError(code, message));
    else emit({ type: 'error', code, message, recoverable: false });
  };

  // Turns whose `final` can no longer arrive (the socket they were committed on
  // is gone) end with an empty transcript, so the session returns to listening.
  const abandonPending = () => {
    const lost = pending.filter(entry => !entry.discard);
    pending = [];
    committed = 0;
    for (let i = 0; i < lost.length; i++) emit({ type: 'final', text: '' });
  };

  // The turn whose text the caption shows: the one being spoken, else the newest
  // one that waits for its `final`. Text of an older turn (its tail can arrive
  // while the next turn is already being spoken) is not the caption of this one.
  const captionTurn = () => {
    if (turnOpen) return committed + 1;
    const waiting = pending.filter(entry => !entry.discard);
    return waiting.length ? waiting[waiting.length - 1].turn : null;
  };

  const isCaptionDelta = msg => {
    const turn = captionTurn();
    if (turn === null) return false;
    return !Number.isInteger(msg.turn) || msg.turn === turn;
  };

  const handleMessage = raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        clearTimeout(readyTimer);
        readyTimer = null;
        // A reconnect that works restores the budget for the next outage.
        reconnects = 0;
        settleStart();
        break;
      case 'delta':
        if (isCaptionDelta(msg)) {
          interimText = `${interimText}${msg.text || ''}`;
          emit({ type: 'interim', text: interimText.replace(/\s+/g, ' ').trim() });
        }
        break;
      case 'final': {
        const turn = Number.isInteger(msg.turn) ? msg.turn : pending[0]?.turn;
        const index = pending.findIndex(entry => entry.turn === turn);
        // A turn nobody waits for: answered already, or from before a reconnect.
        if (index === -1) break;
        const [entry] = pending.splice(index, 1);
        // Commits older than the answered one cannot be answered any more.
        const skipped = pending.splice(0, index).filter(other => !other.discard);
        // The caption of a turn that is being spoken is not this turn's to clear.
        if (!turnOpen) interimText = '';
        for (let i = 0; i < skipped.length; i++) emit({ type: 'final', text: '' });
        if (!entry.discard) emit({ type: 'final', text: String(msg.text ?? '').trim() });
        break;
      }
      case 'error':
        sawServerError = true;
        fail(msg.code || 'service', msg.message || 'Transcription service error');
        break;
      default:
        break;
    }
  };

  const handleClose = event => {
    if (stopped || failed) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    if (!startSettled) {
      fail('connection', 'The speech connection could not be opened');
      return;
    }
    if (sawServerError || isRefusalClose(event?.code) || reconnects >= 1) {
      abandonPending();
      fail('connection', 'The speech connection was lost');
      return;
    }
    reconnects += 1;
    // Audio of the turn in progress went to the socket that just died.
    if (turnOpen) turnTruncated = true;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      abandonPending();
      connect(true);
    }, reconnectDelayMs);
  };

  function connect(isReconnect) {
    if (stopped || failed) return;
    let socket;
    try {
      socket = createWebSocket(getUrl());
    } catch (err) {
      fail('connection', err?.message || 'The speech connection could not be opened');
      return;
    }
    socket.binaryType = 'arraybuffer';
    ws = socket;
    sawServerError = false;
    socket.onopen = () => {
      if (socket !== ws || stopped) return;
      sendJson({ type: 'start', modelId, lang: toRecognitionLang(language), conversation: true });
      clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => sendJson({ type: 'keepalive' }), keepaliveMs);
    };
    socket.onmessage = event => {
      if (socket === ws) handleMessage(event.data);
    };
    // The close that follows an error carries the outcome.
    socket.onerror = () => {};
    socket.onclose = event => {
      if (socket === ws) handleClose(event);
    };
    if (isReconnect) {
      readyTimer = setTimeout(
        () => fail('connection', 'The speech connection could not be restored'),
        readyTimeoutMs
      );
    }
  }

  return {
    /** Open the socket; resolves with the server's `ready`. */
    start() {
      return new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
        readyTimer = setTimeout(
          () => fail('connection', 'The speech service did not answer'),
          readyTimeoutMs
        );
        connect(false);
      });
    },

    /** Speech was confirmed: send what came before it, then audio as it arrives. */
    beginTurn(preRoll) {
      if (muted || stopped) return;
      turnOpen = true;
      turnTruncated = false;
      interimText = '';
      sendAudio(preRoll);
    },

    pushAudio(pcm) {
      if (turnOpen && !muted && !stopped) sendAudio(pcm);
    },

    /** End of the user's turn: the server answers with `final` for it. */
    commitTurn() {
      if (!turnOpen) return;
      turnOpen = false;
      if (turnTruncated) {
        // Only the end of the sentence reached the new socket: flush it away (if
        // there is a socket) and report an empty transcript instead of a wrong one.
        turnTruncated = false;
        interimText = '';
        if (sendJson({ type: 'commit' })) {
          committed += 1;
          pending.push({ turn: committed, discard: true });
        }
        emit({ type: 'final', text: '' });
      } else if (sendJson({ type: 'commit' })) {
        committed += 1;
        pending.push({ turn: committed, discard: false });
      } else {
        // No socket right now (reconnecting): nothing will answer this turn.
        emit({ type: 'final', text: '' });
      }
    },

    /** The turn is dropped (muted mid-sentence): flush the server, ignore its answer. */
    cancelTurn() {
      if (!turnOpen) return;
      turnOpen = false;
      turnTruncated = false;
      interimText = '';
      if (sendJson({ type: 'commit' })) {
        committed += 1;
        pending.push({ turn: committed, discard: true });
      }
    },

    // Keepalives run the whole session, whatever the app is doing.
    setAgentState() {},
    setListeningStyle() {},

    setMuted(value) {
      muted = Boolean(value);
    },

    stop() {
      if (stopped) return;
      sendJson({ type: 'stop' });
      stopped = true;
      clearTimers();
      pending = [];
      const socket = ws;
      ws = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    }
  };
}
