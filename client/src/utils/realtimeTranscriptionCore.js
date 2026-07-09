/**
 * Shared realtime-transcription primitives used by both the microphone dictation
 * service (`vllmRealtimeRecognitionService.js`) and the buffer-transcription
 * client (`transcribeAudioBuffer.js`).
 *
 * All audio sent to the iHub `/api/voice/realtime` WebSocket must be mono PCM16
 * at 16 kHz — the format the upstream vLLM realtime API expects.
 */

export const TARGET_SAMPLE_RATE = 16000;

// Samples per AudioWorklet post (~128 ms @ 16 kHz).
export const FRAME_SIZE = 2048;

// Inline AudioWorklet: accumulates FRAME_SIZE samples then posts a copy to the
// main thread. Loaded via a Blob URL so no separate asset/bundling is needed.
export const WORKLET_SOURCE = `
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
 * Downmix an AudioBuffer to mono and resample it to 16 kHz using an
 * OfflineAudioContext, returning the rendered Float32 sample data.
 *
 * `extractAudioFromVideo()` and `AudioContext.decodeAudioData()` both produce
 * buffers at the source's ORIGINAL sample rate and channel count (44.1/48 kHz,
 * stereo). Rendering through a mono, 16 kHz OfflineAudioContext performs both
 * the channel downmix and the resample natively (issue #1927 gap G4).
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<Float32Array>} mono 16 kHz samples
 */
export async function resampleTo16kMono(audioBuffer) {
  if (!audioBuffer || !audioBuffer.length) {
    return new Float32Array(0);
  }

  // Already mono @ 16 kHz — no work needed.
  if (audioBuffer.numberOfChannels === 1 && audioBuffer.sampleRate === TARGET_SAMPLE_RATE) {
    return audioBuffer.getChannelData(0).slice();
  }

  const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtor) {
    // No OfflineAudioContext (very old browser): fall back to a manual downmix
    // of channel 0 + linear resample so we still emit 16 kHz mono.
    return downsample(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
  }

  const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineCtor(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
