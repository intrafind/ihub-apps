import { TARGET_SAMPLE_RATE } from './audioUtils';

/**
 * Ring buffer of the most recent microphone audio (PCM16, 16 kHz).
 *
 * Voice activity detection needs a moment to be sure that someone is speaking
 * (`minSpeechMs`) and reports it a little later still. By then the first
 * syllable has long gone past. The session therefore keeps the last second or so
 * in this buffer while nobody speaks; when speech is confirmed, the adapter is
 * handed what was said just before, so the first word is not cut off.
 *
 * @param {Object} [options]
 * @param {number} [options.sampleRate] - 16000.
 * @param {number} [options.capacityMs] - How much audio the buffer holds.
 */
export function createPreRollBuffer({
  sampleRate = TARGET_SAMPLE_RATE,
  capacityMs = 1500
} = {}) {
  const capacity = Math.max(1, Math.round((capacityMs / 1000) * sampleRate));
  const ring = new Int16Array(capacity);
  let writeIndex = 0; // where the next sample goes
  let filled = 0; // how many samples are valid (<= capacity)

  const msToSamples = ms => Math.max(0, Math.round((ms / 1000) * sampleRate));

  return {
    /** Append samples; the oldest ones fall out when the buffer is full. */
    push(samples) {
      if (!samples?.length) return;
      // A chunk longer than the buffer: only its tail can survive.
      const source = samples.length > capacity ? samples.subarray(samples.length - capacity) : samples;
      const first = Math.min(source.length, capacity - writeIndex);
      ring.set(source.subarray(0, first), writeIndex);
      if (first < source.length) ring.set(source.subarray(first), 0);
      writeIndex = (writeIndex + source.length) % capacity;
      filled = Math.min(capacity, filled + source.length);
    },

    /**
     * The most recent `ms` of audio (less if the buffer holds less), oldest
     * first. The buffer is emptied: from now on the audio goes to the adapter.
     * @param {number} [ms] - Defaults to everything held.
     * @returns {Int16Array}
     */
    take(ms) {
      const wanted = ms === undefined ? filled : Math.min(filled, msToSamples(ms));
      const out = new Int16Array(wanted);
      const start = (writeIndex - wanted + capacity) % capacity;
      const first = Math.min(wanted, capacity - start);
      out.set(ring.subarray(start, start + first), 0);
      if (first < wanted) out.set(ring.subarray(0, wanted - first), first);
      filled = 0;
      writeIndex = 0;
      return out;
    },

    /** Forget everything (muted, session suspended). */
    clear() {
      filled = 0;
      writeIndex = 0;
    },

    /** Samples held. */
    size() {
      return filled;
    },

    /** Milliseconds of audio held. */
    durationMs() {
      return (filled / sampleRate) * 1000;
    }
  };
}
