import { buildWsUrl } from '../../../../utils/runtimeBasePath';
import { pcmToArrayBuffer, concatInt16 } from './audioUtils';
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
 *   keepalive (about every 15 s, the whole session)
 *   stop
 *
 * Audio only goes up while the user speaks (the session hands the adapter the
 * pre-roll when a turn starts, then each frame until it ends), so a GPU-backed
 * model is not fed the silence while the app talks. `final` frames carry the
 * number of the turn (the n-th `commit` of the socket): a final of a turn that is
 * no longer waited for is ignored.
 *
 * An unexpected close is answered with one reconnect (a fresh `start`); after
 * that the session fails with an unrecoverable error.
 */

/** The server's idle timeout is 60 s; keep well inside it. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** Above this many queued bytes (about 8 s of audio) frames are dropped, not queued. */
export const MAX_BUFFERED_BYTES = 256 * 1024;
const READY_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 250;
// Close codes that are an answer, not a failure of the network: policy
// violation (not logged in, origin refused), unsupported data, message too big,
// and the application range (which the bridge uses for refusals).
const NO_RECONNECT_CLOSE = code => code === 1008 || code === 1003 || code === 1009 || code >= 4000;

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
  const OPEN = 1; // WebSocket.OPEN, also on fakes
  let ws = null;
  let stopped = false;
  let reconnects = 0;
  let keepaliveTimer = null;
  let reconnectTimer = null;
  let readyTimer = null;
  let startSettled = false;
  let resolveStart = null;
  let rejectStart = null;
  let muted = false;
  // Is audio flowing to the socket for a turn right now?
  let turnOpen = false;
  // Turns committed on the current socket (the server counts the same way) and
  // the ones whose `final` is still awaited, oldest first.
  let committed = 0;
  let pending = [];
  // Turns to answer with nothing: cancelled by the user (mute) or lost with a socket.
  let interimText = '';
  let sawServerError = false;
  let droppedFrames = 0;

  const isOpen = () => ws && ws.readyState === OPEN;

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
    if (!isOpen() || !pcm?.length) return;
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

  const fail = (code, message) => {
    if (stopped) return;
    if (!startSettled) {
      settleStart(sessionError(code, message));
      return;
    }
    emit({ type: 'error', code, message, recoverable: false });
  };

  // Turns whose `final` can no longer arrive (the socket they were committed on
  // is gone) end with an empty transcript, so the session returns to listening.
  const abandonPending = () => {
    const lost = pending.filter(entry => !entry.discard);
    pending = [];
    committed = 0;
    for (const entry of lost) emit({ type: 'final', text: '' });
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
        settleStart();
        break;
      case 'delta':
        if (turnOpen || pending.length) {
          interimText = `${interimText}${msg.text || ''}`;
          emit({ type: 'interim', text: interimText.replace(/\s+/g, ' ').trim() });
        }
        break;
      case 'final': {
        const turn = Number.isInteger(msg.turn) ? msg.turn : pending[0]?.turn;
        const index = pending.findIndex(entry => entry.turn === turn);
        // A turn nobody waits for (already answered, from before a reconnect).
        if (index === -1) break;
        const [entry] = pending.splice(index, 1);
        // Older commits cannot be answered after a newer one: end them empty.
        const skipped = pending.splice(0, index).filter(other => !other.discard);
        interimText = '';
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

  const startKeepalive = () => {
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendJson({ type: 'keepalive' }), keepaliveMs);
  };

  const handleClose = event => {
    if (stopped) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    const code = event?.code;
    if (sawServerError || NO_RECONNECT_CLOSE(code) || reconnects >= 1) {
      abandonPending();
      fail('connection-lost', 'The speech connection was lost');
      return;
    }
    if (!startSettled) {
      // Closed while connecting: the session never came up.
      fail('connection-lost', 'The speech connection could not be opened');
      return;
    }
    reconnects += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      abandonPending();
      connect(true);
    }, reconnectDelayMs);
  };

  function connect(isReconnect = false) {
    if (stopped) return;
    let socket;
    try {
      socket = createWebSocket(getUrl());
    } catch (err) {
      fail('connection-lost', err?.message || 'The speech connection could not be opened');
      return;
    }
    socket.binaryType = 'arraybuffer';
    ws = socket;
    sawServerError = false;
    socket.onopen = () => {
      if (socket !== ws || stopped) return;
      sendJson({
        type: 'start',
        modelId,
        lang: toRecognitionLang(language),
        conversation: true
      });
      startKeepalive();
    };
    socket.onmessage = event => {
      if (socket === ws) handleMessage(event.data);
    };
    socket.onerror = () => {
      // The close that follows carries the outcome.
    };
    socket.onclose = event => {
      if (socket === ws) handleClose(event);
    };
    if (isReconnect) {
      // The server holds audio sent before `ready`, so streaming can go on.
      readyTimer = setTimeout(
        () => fail('connection-lost', 'The speech connection could not be restored'),
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
          () => settleStart(sessionError('connection-lost', 'The speech service did not answer')),
          readyTimeoutMs
        );
        connect(false);
      });
    },

    /** Speech was confirmed: send what came before, then audio as it arrives. */
    beginTurn(preRoll) {
      if (muted || stopped) return;
      turnOpen = true;
      interimText = '';
      if (preRoll?.length) sendAudio(preRoll);
    },

    pushAudio(pcm) {
      if (!turnOpen || muted || stopped) return;
      sendAudio(pcm);
    },

    /** End of the user's turn: the server answers with `final` for it. */
    commitTurn() {
      if (!turnOpen) return;
      turnOpen = false;
      if (!sendJson({ type: 'commit' })) {
        // No socket right now (reconnecting): nothing will answer this turn.
        emit({ type: 'final', text: '' });
        return;
      }
      committed += 1;
      pending.push({ turn: committed, discard: false });
    },

    /** The turn is dropped (muted mid-sentence): flush the server, ignore its answer. */
    cancelTurn() {
      if (!turnOpen) return;
      turnOpen = false;
      interimText = '';
      if (sendJson({ type: 'commit' })) {
        committed += 1;
        pending.push({ turn: committed, discard: true });
      }
    },

    setAgentState() {
      // Keepalives run the whole session, whatever the app is doing.
    },

    setMuted(value) {
      muted = Boolean(value);
    },

    setListeningStyle() {},

    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
      pending = [];
      if (ws) {
        const socket = ws;
        ws = null;
        sendJson.call(null, {}); // no-op placeholder to keep the shape simple
        try {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'stop' }));
        } catch {
          /* ignore */
        }
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    },

    // For tests: how the adapter sees the world.
    _debug: () => ({ committed, pending: pending.length, reconnects, droppedFrames })
  };
}

export { concatInt16 };
