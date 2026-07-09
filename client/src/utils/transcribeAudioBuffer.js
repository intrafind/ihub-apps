import { buildWsUrl } from './runtimeBasePath';
import { resampleTo16kMono, floatTo16BitPCM } from './realtimeTranscriptionCore';

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

// ~32 KB PCM16 per frame — well under the server's 256 KB maxPayload.
const CHUNK_SAMPLES = 16384;
// Pause streaming while the browser socket has more than this queued, so we
// don't buffer the whole file client-side.
const HIGH_WATER_MARK_BYTES = 1_000_000;
// How long to wait for the upstream to become ready before giving up.
const READY_TIMEOUT_MS = 20_000;
// Hard ceiling on the whole session (upstream processing can lag a long file).
const OVERALL_TIMEOUT_MS = 10 * 60_000;

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
    let committed = '';
    let partial = '';
    let overallTimer = null;
    let readyTimer = null;

    const currentText = () => `${committed} ${partial}`.replace(/\s+/g, ' ').trim();

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
      const text = currentText();
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

    overallTimer = setTimeout(() => {
      // Best-effort: if we have any text, treat the timeout as completion.
      if (committed || partial) finish();
      else fail('timeout', 'Transcription timed out');
    }, OVERALL_TIMEOUT_MS);

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
          partial = `${partial}${msg.text || ''}`;
          if (typeof onDelta === 'function') onDelta(currentText());
          break;
        case 'final':
          committed = `${committed} ${msg.text || partial}`.trim();
          partial = '';
          if (typeof onDelta === 'function') onDelta(currentText());
          break;
        case 'done':
          finish();
          break;
        case 'error':
          fail('service', msg.message);
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
      // A clean close after streaming completes is treated as completion; a
      // close before we ever streamed is a failure.
      if (stopSent || committed || partial) finish();
      else fail('closed', 'Transcription connection closed unexpectedly');
    };
  });
}

export default transcribeAudioBuffer;
