import { buildWsUrl } from './runtimeBasePath';
import {
  TARGET_SAMPLE_RATE,
  createPcmCapturePipeline,
  createTranscriptAssembler,
  downsample,
  floatTo16BitPCM,
  isCompletionClose
} from './realtimeTranscriptionCore';

// Wait this long for the upstream to become ready (the first session after a
// vLLM restart can block on model load). Frames captured meanwhile are held.
const READY_TIMEOUT_MS = 30_000;
// Bound on audio held before `ready` — ~30 s of 16 kHz PCM16, which covers the
// ready timeout above.
const MAX_PENDING_BYTES = 1024 * 1024;
// Bound on audio queued in the browser while the server is not reading it (it
// pauses the socket when the transcription upstream falls behind) — ~4 minutes
// of 16 kHz PCM16. Past it the session fails instead of buffering a long
// recording in the tab.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// After `stop`, the transcript normally completes within the server's settle
// window; a batch model transcribes the whole recording first. Generous last
// resort: twice the recording plus a minute, never under two minutes.
const stopTimeoutFor = durationSeconds =>
  Math.max(120_000, Math.ceil(durationSeconds * 2 * 1000) + 60_000);

const transcriptionError = (code, message, partialText) =>
  Object.assign(new Error(message || code), { code, partialText });

/**
 * Live transcription of the microphone with a transcription model (the chat's
 * record button). Audio streams to the iHub `/api/voice/realtime` WebSocket as
 * it is captured, and the running transcript is reported on every delta, so
 * the caller can grow a message while the user is still speaking.
 *
 * Unlike dictation (`vllmRealtimeRecognitionService.js`, the platform backend,
 * voice-activity auto-stop) the session names a transcription model and runs
 * until the caller stops it. Unlike `transcribeAudioBuffer()` nothing is
 * buffered client-side beyond the few frames captured before the upstream is
 * ready. A batch model (google-transcribe) reports no deltas: its transcript
 * arrives in one piece after `stop()`.
 *
 * Usage:
 *   const session = await startLiveTranscription({ modelId, onText, onError });
 *   // ... user speaks, onText(runningTranscript) fires ...
 *   const transcript = await session.stop();
 *
 * @param {Object} opts
 * @param {string} opts.modelId - Transcription model id to route to.
 * @param {(text: string) => void} [opts.onText] - Running transcript on each update.
 * @param {(err: Error & { code: string, partialText: string }) => void} [opts.onError]
 *   A failure while recording (before `stop()`); after `stop()` the returned
 *   promise rejects instead.
 * @param {(elapsedSeconds: number) => void} [opts.onTick] - Recording time, every 250 ms.
 * @param {number} [opts.maxDurationSeconds] - Calls `onMaxDuration` once when reached.
 * @param {() => void} [opts.onMaxDuration]
 * @returns {Promise<{ stop: () => Promise<string>, cancel: () => void, text: () => string }>}
 *   Rejects with `code: 'mic'` when the microphone is unavailable and
 *   `code: 'connect'` when the socket cannot be opened.
 */
export async function startLiveTranscription({
  modelId,
  onText,
  onError,
  onTick,
  maxDurationSeconds,
  onMaxDuration
} = {}) {
  let mediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw transcriptionError('mic', err?.message);
  }

  const transcript = createTranscriptAssembler();
  let ws = null;
  let pipeline = null;
  let ready = false;
  let capturing = false;
  let stopRequested = false;
  let stopSent = false;
  let settled = false;
  // Set once the session is handed to the caller. A failure before that
  // rejects the start instead of reaching `onError`.
  let started = false;
  let failure = null;
  const pending = [];
  let pendingBytes = 0;
  let readyTimer = null;
  let stopTimer = null;
  let tickTimer = null;
  let startedAt = 0;
  let elapsedSeconds = 0;

  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A failure before anyone awaits `stop()` is reported through `onError`;
  // the promise must not surface as an unhandled rejection meanwhile.
  result.catch(() => {});

  const stopCapture = () => {
    capturing = false;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (pipeline) {
      pipeline.stop();
      pipeline = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
  };

  const cleanup = () => {
    stopCapture();
    if (readyTimer) clearTimeout(readyTimer);
    if (stopTimer) clearTimeout(stopTimer);
    readyTimer = null;
    stopTimer = null;
    pending.length = 0;
    pendingBytes = 0;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveResult(transcript.text());
  };

  const fail = (code, message, { silent = false } = {}) => {
    if (settled) return;
    settled = true;
    cleanup();
    const err = transcriptionError(code, message, transcript.text());
    failure = err;
    rejectResult(err);
    if (started && !stopRequested && !silent && typeof onError === 'function') onError(err);
  };

  const sendStop = () => {
    if (stopSent || !ws || ws.readyState !== WebSocket.OPEN) return;
    stopSent = true;
    try {
      ws.send(JSON.stringify({ type: 'stop' }));
    } catch {
      /* ignore */
    }
  };

  const onFrame = (float32, inputRate) => {
    if (!capturing || settled) return;
    const samples = inputRate === TARGET_SAMPLE_RATE ? float32 : downsample(float32, inputRate);
    const pcm16 = floatTo16BitPCM(samples);
    if (ready && ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        fail('server-busy', 'The transcription service is not keeping up with the recording');
        return;
      }
      ws.send(pcm16.buffer);
    } else if (pendingBytes + pcm16.byteLength <= MAX_PENDING_BYTES) {
      pending.push(pcm16.buffer);
      pendingBytes += pcm16.byteLength;
    }
  };

  const handleMessage = msg => {
    switch (msg.type) {
      case 'ready':
        if (ready) break;
        ready = true;
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        for (const chunk of pending) ws.send(chunk);
        pending.length = 0;
        pendingBytes = 0;
        // Stopped before the upstream was up: the held audio is all there is.
        if (stopRequested) sendStop();
        break;
      case 'delta':
        transcript.applyDelta(msg.text);
        if (typeof onText === 'function') onText(transcript.text());
        break;
      case 'final':
        transcript.applyFinal(msg.text);
        if (typeof onText === 'function') onText(transcript.text());
        break;
      case 'done':
        finish();
        break;
      case 'error':
        // Stable machine-readable code from the server (e.g. 'not-permitted',
        // 'upstream-unreachable', 'session-limit').
        fail(msg.code || 'service', msg.message);
        break;
      default:
        break;
    }
  };

  try {
    await new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(buildWsUrl('/voice/realtime'));
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'start', modelId }));
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error('Transcription connection failed'));
      };
      ws.onclose = evt => {
        if (!opened) {
          reject(new Error('Transcription connection closed before opening'));
          return;
        }
        if (settled) return;
        // Completion is only trusted after `stop` was sent, and only on the
        // server's own completion close: it ends a finished session with
        // `done`, or by closing itself (no status code) when the upstream
        // closed normally. A dropped connection (a proxy timeout, the network)
        // or a close with an error code truncates the transcript — which must
        // not be sent as if it were complete.
        if (stopSent && isCompletionClose(evt)) finish();
        else fail('interrupted', 'Transcription connection closed before completion');
      };
      ws.onmessage = evt => {
        if (settled) return;
        let msg;
        try {
          msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
        } catch {
          return;
        }
        handleMessage(msg);
      };
    });
  } catch (err) {
    settled = true;
    cleanup();
    throw transcriptionError('connect', err?.message);
  }

  try {
    pipeline = await createPcmCapturePipeline(mediaStream, onFrame);
  } catch (err) {
    settled = true;
    cleanup();
    throw transcriptionError('mic', err?.message);
  }
  // The server refused the session (e.g. 'not-permitted') or the socket
  // closed while the microphone was being set up.
  if (settled) {
    cleanup();
    throw failure;
  }

  capturing = true;
  started = true;
  startedAt = performance.now();
  readyTimer = setTimeout(() => {
    if (!ready) fail('not-ready', 'Transcription service did not become ready');
  }, READY_TIMEOUT_MS);
  let maxDurationFired = false;
  tickTimer = setInterval(() => {
    elapsedSeconds = (performance.now() - startedAt) / 1000;
    if (typeof onTick === 'function') onTick(elapsedSeconds);
    if (maxDurationSeconds && elapsedSeconds >= maxDurationSeconds && !maxDurationFired) {
      // Once: the caller's stop handler must not race itself every tick.
      maxDurationFired = true;
      if (typeof onMaxDuration === 'function') onMaxDuration();
    }
  }, 250);

  return {
    /**
     * Stop recording (the microphone is released at once) and resolve with
     * the complete transcript once the server reports it done.
     * @returns {Promise<string>}
     */
    stop() {
      if (settled || stopRequested) return result;
      stopRequested = true;
      stopCapture();
      if (ready) sendStop();
      stopTimer = setTimeout(
        () => fail('timeout', 'Transcription timed out'),
        stopTimeoutFor(elapsedSeconds)
      );
      return result;
    },
    /** Discard the session. A pending `stop()` rejects with code 'aborted'. */
    cancel() {
      fail('aborted', 'Transcription cancelled', { silent: true });
    },
    /** The transcript so far. */
    text() {
      return transcript.text();
    }
  };
}

export default startLiveTranscription;
