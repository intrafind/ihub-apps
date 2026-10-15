/**
 * Encode audio as a 16-bit PCM WAV file: the sound track extracted from audio
 * and video uploads, and the recording a custom read-aloud voice is made from.
 */
import { throwIfAborted, yieldToEventLoop } from './abortable';

const HEADER_BYTES = 44;
const BIT_DEPTH = 16;
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;

/**
 * Frames encoded per slice by `audioBufferToWavAsync`: about 8 ms of work for
 * a mono track, so a slice never holds up input or painting.
 */
const WAV_CHUNK_FRAMES = 1 << 19;

const writeString = (view, offset, string) => {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
};

/** Allocate the WAV file and write its header; the samples are written after. */
const createWav = audioBuffer => {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM

  const blockAlign = numberOfChannels * BYTES_PER_SAMPLE;

  const channels = [];
  for (let i = 0; i < numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  const dataLength = audioBuffer.length * numberOfChannels * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataLength);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BIT_DEPTH, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  return { buffer, view, channels };
};

/** Write the interleaved samples of frames `from` up to `to`. */
const writeFrames = (view, channels, from, to) => {
  let offset = HEADER_BYTES + from * channels.length * BYTES_PER_SAMPLE;
  for (let i = from; i < to; i++) {
    for (let channel = 0; channel < channels.length; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += BYTES_PER_SAMPLE;
    }
  }
};

/**
 * Convert AudioBuffer to WAV Blob
 * @param {AudioBuffer} audioBuffer - The audio buffer to convert
 * @returns {Blob} WAV file blob
 */
export const audioBufferToWav = audioBuffer => {
  const { buffer, view, channels } = createWav(audioBuffer);
  writeFrames(view, channels, 0, audioBuffer.length);
  return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * `audioBufferToWav` for long audio: the same file, byte for byte, encoded in
 * slices with the event loop in between. Encoding a long track in one go holds
 * the page for about half a second per 40 minutes of 16 kHz mono, and the
 * progress it could report would never be painted.
 *
 * @param {AudioBuffer} audioBuffer - The audio buffer to convert
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Stops at the next slice, rejecting
 *   with the abort error (see `abortable.js`)
 * @param {(percent: number) => void} [options.onProgress] - Percent (0-100) of
 *   the samples encoded, after each slice
 * @param {number} [options.chunkSamples] - Frames per slice
 * @returns {Promise<Blob>} WAV file blob
 */
export const audioBufferToWavAsync = async (
  audioBuffer,
  { signal, onProgress, chunkSamples = WAV_CHUNK_FRAMES } = {}
) => {
  throwIfAborted(signal);
  const { buffer, view, channels } = createWav(audioBuffer);
  const total = audioBuffer.length;
  const step = Math.max(1, Math.floor(chunkSamples));

  for (let from = 0; from < total; from += step) {
    throwIfAborted(signal);
    const to = Math.min(from + step, total);
    writeFrames(view, channels, from, to);
    onProgress?.((to / total) * 100);
    if (to < total) await yieldToEventLoop();
  }

  throwIfAborted(signal);
  if (total === 0) onProgress?.(100);
  return new Blob([buffer], { type: 'audio/wav' });
};

export default audioBufferToWav;
