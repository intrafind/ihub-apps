/**
 * Audio helpers for the batch transcription providers, which upload the PCM16
 * the browser streams as a file: the WAV wrapper, and cutting a long recording
 * into parts a service accepts.
 */

/** How far back from a part's end the quietest moment is looked for. */
const QUIET_SEARCH_SECONDS = 10;
const QUIET_WINDOW_MS = 50;
const DEFAULT_SPLIT_SECONDS = 600;

/**
 * Wrap raw little-endian PCM16 samples in a minimal RIFF/WAVE container.
 * Upload APIs need a self-describing audio file; the browser streams bare
 * PCM, so the 44-byte header is added server-side.
 *
 * @param {Buffer} pcm - Raw PCM16 little-endian samples.
 * @param {{ sampleRate?: number, channels?: number }} [opts]
 * @returns {Buffer} A complete WAV file.
 */
export function pcm16ToWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Split PCM16 into parts of at most `maxChunkSeconds`, each ending at the
 * quietest 50 ms of its last ten seconds, so a cut falls between words.
 *
 * @param {Buffer} pcm
 * @param {{ sampleRate?: number, maxChunkSeconds?: number }} [opts]
 * @returns {Buffer[]}
 */
export function splitPcm(
  pcm,
  { sampleRate = 16000, maxChunkSeconds = DEFAULT_SPLIT_SECONDS } = {}
) {
  const bytesPerSecond = sampleRate * 2;
  const maxBytes = Math.max(2, Math.floor((maxChunkSeconds * bytesPerSecond) / 2) * 2);
  if (pcm.length <= maxBytes) return [pcm];

  const windowBytes = Math.max(2, Math.floor((sampleRate * QUIET_WINDOW_MS) / 1000) * 2);
  const searchBytes = Math.floor((QUIET_SEARCH_SECONDS * bytesPerSecond) / 2) * 2;
  const parts = [];
  let start = 0;
  while (pcm.length - start > maxBytes) {
    const limit = start + maxBytes;
    const from = Math.max(start + windowBytes, limit - searchBytes);
    let cut = limit;
    let quietest = Infinity;
    for (let windowStart = limit - windowBytes; windowStart >= from; windowStart -= windowBytes) {
      let energy = 0;
      for (let at = windowStart; at < windowStart + windowBytes; at += 2) {
        const sample = pcm.readInt16LE(at);
        energy += sample * sample;
      }
      if (energy < quietest) {
        quietest = energy;
        cut = windowStart + Math.floor(windowBytes / 4) * 2;
      }
    }
    parts.push(pcm.subarray(start, cut));
    start = cut;
  }
  parts.push(pcm.subarray(start));
  return parts;
}
