import { buildWsUrl } from './runtimeBasePath';
import {
  CHUNK_SAMPLES,
  TARGET_SAMPLE_RATE,
  createTranscriptAssembler,
  resampleTo16kMono,
  floatTo16BitPCM
} from './realtimeTranscriptionCore';

/**
 * Stream a complete decoded audio buffer to the iHub `/api/voice/realtime`
 * WebSocket for transcription by a self-hosted Voxtral (vLLM) transcription
 * model, and reassemble the streamed deltas/finals into one transcript.
 *
 * Unlike the microphone dictation service (which trickles audio in real time),
 * this blasts a whole buffer, so it must respect backpressure:
 *   - It waits for the server's `{type:'ready'}` before sending any audio.
 *     Frames sent before the upstream socket is ready are dropped past a small
 *     server-side buffer (issue #1927 gap G3).
 *   - It paces sending by `ws.bufferedAmount` so neither the browser socket nor
 *     the server→upstream socket buffers the entire file in memory.
 *   - It sends `{type:'stop'}` after the last frame and resolves on the server's
 *     `{type:'done'}` completion frame (gap G8) or the socket closing.
 *
 * The vLLM URL / API key never reach the browser: only a server-resolved
 * `modelId` is sent.
 *
 * @param {AudioBuffer} audioBuffer - Decoded source audio (any rate/channels).
 * @param {Object} opts
 * @param {string} opts.modelId - Transcription model id to route to.
 * @param {(text: string) => void} [opts.onDelta] - Running transcript on each update.
 * @param {(text: string) => void} [opts.onFinal] - Final transcript when complete.
 * @param {(err: { code: string, message?: string }) => void} [opts.onError]
 * @param {AbortSignal} [opts.signal] - Abort/cancel the transcription.
 * @returns {Promise<string>} Resolves with the final transcript.
 */

// Pause streaming while the browser socket has more than this queued, so we
// don't buffer the whole file client-side.
const HIGH_WATER_MARK_BYTES = 1_000_000;
// How long to wait for the upstream to become ready before giving up. Generous:
// the first session after a vLLM (re)start can block on model load.
const READY_TIMEOUT_MS = 30_000;
// Base hard ceiling on the whole session. Scaled up for long inputs (see
// overallTimeoutFor) so a 15-minute recording on a busy GPU isn't cut off by a
// flat cap shorter than its own audio duration.
const OVERALL_TIMEOUT_BASE_MS = 10 * 60_000;

// Stuck-session ceiling: generous — 2x the audio duration plus a minute of
// headroom, never below the base. This is a last-resort guard (normal
// completion is the server's {type:'done'}), so err on the long side.
const overallTimeoutFor = durationSeconds =>
  Math.max(OVERALL_TIMEOUT_BASE_MS, Math.ceil(durationSeconds * 2 * 1000) + 60_000);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function transcribeAudioBuffer(audioBuffer, opts = {}) {
  const { modelId, onDelta, onFinal, onError, signal } = opts;

  const float32 = await resampleTo16kMono(audioBuffer);
  if (!float32.length) {
    throw new Error('empty-audio');
  }
  const pcm16 = floatTo16BitPCM(float32);

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let ready = false;
    let stopSent = false;
    let overallTimer = null;
    let readyTimer = null;
    // Shared committed/partial accumulation (same semantics as dictation).
    const transcript = createTranscriptAssembler();

    const cleanup = () => {
      if (overallTimer) clearTimeout(overallTimer);
      if (readyTimer) clearTimeout(readyTimer);
      overallTimer = null;
      readyTimer = null;
      if (signal) signal.removeEventListener('abort', onAbort);
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
      const text = transcript.text();
      cleanup();
      if (typeof onFinal === 'function') onFinal(text);
      resolve(text);
    };

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof onError === 'function') onError({ code, message });
      const err = new Error(message || code);
      err.code = code;
      reject(err);
    };

    const onAbort = () => fail('aborted', 'Transcription cancelled');

    if (signal) {
      if (signal.aborted) {
        fail('aborted', 'Transcription cancelled');
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    overallTimer = setTimeout(
      () => {
        // A stuck session is an error even with partial text — the caller keeps
        // the partial transcript (via onDelta) and annotates it as interrupted.
        fail('timeout', 'Transcription timed out');
      },
      overallTimeoutFor(float32.length / TARGET_SAMPLE_RATE)
    );

    try {
      ws = new WebSocket(buildWsUrl('/voice/realtime'));
    } catch (err) {
      fail('connect', err.message);
      return;
    }
    ws.binaryType = 'arraybuffer';

    // Stream all PCM16 frames with backpressure, then signal stop.
    const streamAudio = async () => {
      readyTimer && clearTimeout(readyTimer);
      readyTimer = null;
      const totalSamples = pcm16.length;
      for (let off = 0; off < totalSamples; off += CHUNK_SAMPLES) {
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        // Backpressure: let the socket drain before queuing more.
        while (ws.bufferedAmount > HIGH_WATER_MARK_BYTES) {
          await delay(25);
          if (settled || ws.readyState !== WebSocket.OPEN) return;
        }
        const byteStart = off * 2;
        const byteEnd = Math.min(totalSamples, off + CHUNK_SAMPLES) * 2;
        ws.send(pcm16.buffer.slice(byteStart, byteEnd));
      }
      if (settled || ws.readyState !== WebSocket.OPEN) return;
      stopSent = true;
      try {
        ws.send(JSON.stringify({ type: 'stop' }));
      } catch {
        /* ignore */
      }
    };

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'start', modelId }));
      } catch (err) {
        fail('connect', err.message);
        return;
      }
      // Guard: the upstream must become ready before we stream (G3).
      readyTimer = setTimeout(() => {
        if (!ready) fail('not-ready', 'Transcription service did not become ready');
      }, READY_TIMEOUT_MS);
    };

    ws.onmessage = evt => {
      // Message events already queued when the promise settles (e.g. a delta
      // racing an abort) must not fire callbacks anymore — a late onDelta would
      // overwrite the caller's final UI state.
      if (settled) return;
      let msg;
      try {
        msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          if (ready) break;
          ready = true;
          streamAudio();
          break;
        case 'delta':
          transcript.applyDelta(msg.text);
          if (typeof onDelta === 'function') onDelta(transcript.text());
          break;
        case 'final':
          transcript.applyFinal(msg.text);
          if (typeof onDelta === 'function') onDelta(transcript.text());
          break;
        case 'done':
          finish();
          break;
        case 'error':
          // The server sends a stable machine-readable `code` alongside the
          // message (e.g. 'not-permitted', 'upstream-unreachable', 'session-limit').
          fail(msg.code || 'service', msg.message);
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (!settled && !ready) fail('connect', 'Transcription connection failed');
    };

    ws.onclose = () => {
      if (settled) return;
      // Completion is only trusted after `stop` was sent — a close mid-stream
      // means the transcript is TRUNCATED, and silently resolving would present
      // a partial transcript as complete. The caller keeps the partial text via
      // its onDelta bookkeeping and can annotate it as interrupted.
      if (stopSent) finish();
      else fail('interrupted', 'Transcription connection closed before completion');
    };
  });
}

export default transcribeAudioBuffer;
