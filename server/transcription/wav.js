/**
 * Audio container helpers for the batch transcription providers, which upload
 * the PCM16 the browser streams as a file.
 */

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
