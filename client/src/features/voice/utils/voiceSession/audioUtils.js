import {
  TARGET_SAMPLE_RATE,
  downsample,
  floatTo16BitPCM
} from '../../../../utils/realtimeTranscriptionCore';

/**
 * Small audio helpers of the voice session: format conversion to the one
 * format every speech service is fed (mono PCM16 at 16 kHz), a mic level meter
 * for the orb, and buffer arithmetic. Pure functions, no DOM.
 */

export { TARGET_SAMPLE_RATE };

/**
 * Convert one captured Float32 frame (any input rate) to PCM16 at 16 kHz.
 * @param {Float32Array} frame
 * @param {number} inputRate - Sample rate of `frame`.
 * @returns {Int16Array}
 */
export function toPcm16At16k(frame, inputRate) {
  const samples = inputRate === TARGET_SAMPLE_RATE ? frame : downsample(frame, inputRate);
  return floatTo16BitPCM(samples);
}

/** Root mean square of a Float32 frame (0..1). */
export function frameRms(frame) {
  if (!frame?.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/**
 * Map an RMS value to the 0..1 level the orb animates with. Speech after the
 * browser's gain control sits around 0.03-0.2 RMS; the square root curve makes
 * quiet speech visible without clipping loud speech.
 */
export function rmsToLevel(rms) {
  return Math.max(0, Math.min(1, Math.sqrt(rms) * 1.6));
}

/** Concatenate Int16Array chunks into one array. */
export function concatInt16(chunks) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Duration in ms of `samples` PCM samples at 16 kHz. */
export function pcmDurationMs(samples, sampleRate = TARGET_SAMPLE_RATE) {
  return (samples / sampleRate) * 1000;
}

/**
 * The bytes of an Int16Array as an ArrayBuffer of exactly its size (a view's
 * `.buffer` can be larger than the view).
 * @param {Int16Array} pcm
 * @returns {ArrayBuffer}
 */
export function pcmToArrayBuffer(pcm) {
  if (pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength) return pcm.buffer;
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

/**
 * Throttled mic level: remembers the loudest frame since the last report and
 * reports it at most every `intervalMs` (about 15 reports a second by default (every second 32 ms frame)).
 *
 * @param {Object} options
 * @param {(level: number) => void} options.onLevel
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now] - Clock in ms (tests).
 */
export function createLevelMeter({ onLevel, intervalMs = 60, now = () => Date.now() }) {
  let peak = 0;
  let lastReport = -Infinity;
  return {
    /** @param {Float32Array} frame */
    push(frame) {
      peak = Math.max(peak, rmsToLevel(frameRms(frame)));
      const time = now();
      if (time - lastReport < intervalMs) return;
      lastReport = time;
      const level = Math.round(peak * 100) / 100;
      peak = 0;
      onLevel(level);
    },
    /** Report silence at once (muted, suspended). */
    silence() {
      peak = 0;
      lastReport = now();
      onLevel(0);
    }
  };
}
