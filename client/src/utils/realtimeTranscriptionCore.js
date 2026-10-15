/**
 * Shared realtime-transcription primitives used by the microphone dictation
 * service (`modelRecognitionService.js`), live transcription
 * (`liveTranscription.js`) and the buffer-transcription client
 * (`transcribeAudioBuffer.js`).
 *
 * All audio sent to the iHub `/api/voice/realtime` WebSocket must be mono PCM16
 * at 16 kHz — the format the transcription providers are fed.
 */

import { raceAbort, throwIfAborted } from './abortable';

export const TARGET_SAMPLE_RATE = 16000;

// Samples per binary WebSocket frame when streaming a whole buffer
// (transcribeAudioBuffer): ~32 KB PCM16 per frame — well under the server's
// 256 KB maxPayload.
export const CHUNK_SAMPLES = 16384;

// Samples per AudioWorklet post (~128 ms @ 16 kHz).
const FRAME_SIZE = 2048;

// Inline AudioWorklet: accumulates FRAME_SIZE samples then posts a copy to the
// main thread. Loaded via a Blob URL so no separate asset/bundling is needed.
const WORKLET_SOURCE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._size = ${FRAME_SIZE};
    this._buf = new Float32Array(this._size);
    this._i = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let n = 0; n < ch.length; n++) {
        this._buf[this._i++] = ch[n];
        if (this._i >= this._size) {
          this.port.postMessage(this._buf.slice(0, this._size));
          this._i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
`;

/**
 * Linear-interpolation downsample from `inputRate` to 16 kHz.
 * Per-chunk resampling; boundary artifacts are negligible for speech recognition.
 */
export function downsample(samples, inputRate) {
  if (inputRate === TARGET_SAMPLE_RATE) return samples;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] || 0;
    const b = samples[idx + 1] !== undefined ? samples[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Convert a Float32 sample buffer (-1..1) to little-endian PCM16. */
export function floatTo16BitPCM(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Build the microphone→PCM capture pipeline shared by the dictation service and
 * the buffer recorder: an AudioContext (capturing at 16 kHz where the browser
 * honors it — ~3x less memory than a native 48 kHz and no resample step), a
 * MediaStreamSource, and an AudioWorklet posting Float32 frames (with a
 * ScriptProcessor fallback for engines without AudioWorklet).
 *
 * Frames passed to `onFrame` are owned by the receiver (the worklet posts
 * fresh copies; the ScriptProcessor path copies before invoking).
 *
 * `stop()` disconnects the graph and closes the AudioContext. It does NOT stop
 * the media stream's tracks — the caller acquired the stream and owns it.
 *
 * @param {MediaStream} mediaStream - From getUserMedia.
 * @param {(frame: Float32Array, inputSampleRate: number) => void} onFrame
 * @returns {Promise<{ audioContext: AudioContext, sampleRate: number, stop: () => void }>}
 */
export async function createPcmCapturePipeline(mediaStream, onFrame) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

  // Two fallback layers for the 16 kHz capture preference: constructors that
  // reject the sampleRate option, and engines whose createMediaStreamSource
  // refuses a context whose rate differs from the stream's native rate (older
  // Firefox throws NotSupportedError there, not in the constructor).
  const buildGraph = async useTargetRate => {
    const ctx = useTargetRate
      ? new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE })
      : new AudioContextCtor();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      return { ctx, source: ctx.createMediaStreamSource(mediaStream) };
    } catch (err) {
      if (ctx.state !== 'closed') ctx.close().catch(() => {});
      throw err;
    }
  };

  let audioContext;
  let sourceNode;
  try {
    ({ ctx: audioContext, source: sourceNode } = await buildGraph(true));
  } catch {
    ({ ctx: audioContext, source: sourceNode } = await buildGraph(false));
  }

  const sampleRate = audioContext.sampleRate;
  let workletNode = null;
  let scriptNode = null;

  let usedWorklet = false;
  if (audioContext.audioWorklet) {
    try {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const moduleUrl = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
      workletNode.port.onmessage = evt => onFrame(evt.data, sampleRate);
      sourceNode.connect(workletNode);
      // The worklet needs a sink to keep the graph pulling audio.
      workletNode.connect(audioContext.destination);
      usedWorklet = true;
    } catch (err) {
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
    }
  }

  if (!usedWorklet) {
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = e =>
      onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), sampleRate);
    sourceNode.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
  }

  const stop = () => {
    try {
      if (workletNode) {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      }
      if (scriptNode) {
        scriptNode.onaudioprocess = null;
        scriptNode.disconnect();
      }
      sourceNode.disconnect();
    } catch {
      /* ignore */
    }
    if (audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
  };

  return { audioContext, sampleRate, stop };
}

/**
 * Accumulate streaming transcription frames into one transcript with identical
 * semantics for every consumer (dictation and buffer transcription): deltas
 * extend the current utterance, `final` folds the utterance into the committed
 * text (preferring the server-provided final text over the accumulated
 * deltas), and text() is the whitespace-normalized whole.
 */
export function createTranscriptAssembler() {
  let committed = '';
  let partial = '';
  return {
    applyDelta(text) {
      partial = `${partial}${text || ''}`;
    },
    applyFinal(text) {
      committed = `${committed} ${text || partial}`.trim();
      partial = '';
    },
    text() {
      return `${committed} ${partial}`.replace(/\s+/g, ' ').trim();
    },
    hasText() {
      return Boolean(committed || partial);
    }
  };
}

// The audio engine renders in blocks of this many frames; a suspend lands on one.
const RENDER_QUANTUM = 128;
// Progress reports (and chances to stop) while an offline render runs.
const RENDER_CHECKPOINTS = 40;

/**
 * Report how far an OfflineAudioContext has rendered, and stop it when
 * `signal` fires, by suspending the render at evenly spaced frames. A render
 * cannot be cancelled, but one whose source has been disconnected is a render
 * of silence that finishes at once, so the (large) source buffer is released.
 * Does nothing where `suspend()` is missing or the render is too short to be
 * worth it; the render then simply runs to its end.
 */
function trackRendering(offline, source, frameCount, { signal, onProgress }) {
  if (!signal && !onProgress) return;
  const steps = Math.min(RENDER_CHECKPOINTS, Math.floor(frameCount / RENDER_QUANTUM / 8));
  if (typeof offline.suspend !== 'function' || steps < 2) return;
  for (let step = 1; step < steps; step++) {
    const frame = Math.floor((frameCount * step) / steps / RENDER_QUANTUM) * RENDER_QUANTUM;
    offline
      .suspend(frame / TARGET_SAMPLE_RATE)
      .then(() => {
        if (signal?.aborted) source.disconnect();
        else onProgress?.((step / steps) * 100);
        return offline.resume();
      })
      .catch(() => {});
  }
}

/**
 * The part of an AudioBuffer to render: from `offset` seconds, for `duration`
 * seconds (to the end where that is null, undefined, or more than is left).
 * `seconds` is 0 where nothing is left. `limited` says whether `duration` cut the
 * end short, so that the render has to be told how long to play. Without an
 * offset or a duration it is the whole buffer, as long as the buffer says.
 */
function trimSpan(audioBuffer, offset, duration) {
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const asked = Number.isFinite(duration) && duration >= 0;
  if (!start && !asked) return { start: 0, seconds: audioBuffer.duration, limited: false };
  const left = Math.max(0, audioBuffer.duration - start);
  const limited = asked && duration < left;
  return { start, seconds: limited ? duration : left, limited };
}

/**
 * Downmix an AudioBuffer to mono and resample it to 16 kHz using an
 * OfflineAudioContext, returning the rendered Float32 sample data.
 *
 * `extractAudioFromVideo()` and `AudioContext.decodeAudioData()` both produce
 * buffers at the source's ORIGINAL sample rate and channel count (44.1/48 kHz,
 * stereo). Rendering through a mono, 16 kHz OfflineAudioContext performs both
 * the channel downmix and the resample natively (issue #1927 gap G4).
 *
 * `offset` and `duration` render only a part of the buffer: the edit list of an
 * MP4/MOV (a trimmed recording, an encoder's delay) says which. The render is
 * told to start there and is as long as that part, so nothing outside it is
 * resampled. Without them the whole buffer is rendered.
 *
 * @param {AudioBuffer} audioBuffer
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Rejects with the abort error (see
 *   `abortable.js`) as soon as it fires
 * @param {(percent: number) => void} [options.onProgress] - Percent (0-100) of
 *   the render done, a few dozen times along the way. Never called where the
 *   browser cannot suspend an offline render.
 * @param {number} [options.offset] - Seconds of the buffer to skip at the start
 *   (default 0)
 * @param {number|null} [options.duration] - Seconds to render from `offset`;
 *   null or undefined: to the end of the buffer
 * @returns {Promise<Float32Array>} mono 16 kHz samples
 */
export async function resampleTo16kMono(
  audioBuffer,
  { signal, onProgress, offset, duration } = {}
) {
  throwIfAborted(signal);
  if (!audioBuffer || !audioBuffer.length) {
    return new Float32Array(0);
  }

  const { start, seconds, limited } = trimSpan(audioBuffer, offset, duration);
  const trimmed = start > 0 || limited;
  // Nothing of the buffer is inside the part asked for
  if (trimmed && !(seconds > 0)) return new Float32Array(0);
  const frameCount = Math.max(1, Math.ceil(seconds * TARGET_SAMPLE_RATE));

  // Already mono @ 16 kHz — no work needed.
  if (audioBuffer.numberOfChannels === 1 && audioBuffer.sampleRate === TARGET_SAMPLE_RATE) {
    const samples = audioBuffer.getChannelData(0);
    if (!trimmed) return samples.slice();
    const from = Math.min(samples.length, Math.round(start * TARGET_SAMPLE_RATE));
    return samples.slice(from, Math.min(samples.length, from + frameCount));
  }

  const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtor) {
    // No OfflineAudioContext (very old browser): fall back to a manual downmix
    // of channel 0 + linear resample so we still emit 16 kHz mono.
    const { sampleRate } = audioBuffer;
    const samples = audioBuffer.getChannelData(0);
    if (!trimmed) return downsample(samples, sampleRate);
    const from = Math.min(samples.length, Math.round(start * sampleRate));
    const to = Math.min(samples.length, Math.round((start + seconds) * sampleRate));
    return downsample(samples.subarray(from, to), sampleRate);
  }

  const offline = new OfflineCtor(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  if (limited) source.start(0, start, seconds);
  else if (start) source.start(0, start);
  else source.start(0);
  trackRendering(offline, source, frameCount, { signal, onProgress });
  const rendered = await raceAbort(offline.startRendering(), signal);
  // The rendered buffer is nobody else's: no copy needed (a 40-minute track
  // takes the page 0.13 s to copy)
  return rendered.getChannelData(0);
}

/**
 * The close that ends a finished session: a completed close handshake with a
 * normal (1000) or no status code (1005, what the server's plain `close()`
 * sends). Anything else — no handshake (1006), or a policy / internal error
 * code — means the transcript may be cut off.
 * @param {CloseEvent} [evt]
 * @returns {boolean}
 */
export const isCompletionClose = evt =>
  evt?.wasClean === true && (evt.code === 1000 || evt.code === 1005);
