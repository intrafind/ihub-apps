// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Byte-level type detection of the images and audio the verify endpoint
 * accepts (#3328). The client's `Content-Type` and file name are never trusted:
 * the type comes from the magic bytes. SVG and anything unknown is refused
 * (`null`), exactly because SVG can carry script.
 *
 * Wider than the chat upload allowlist on purpose (HEIC, AVIF, TIFF, MP3, FLAC,
 * OGG, M4A): a third party may ask about a file generated elsewhere. The chat
 * upload allowlist is not widened by this.
 *
 * @module services/provenance/mediaSniff
 */

const ascii = (buffer, start, end) => buffer.toString('latin1', start, end);

/** ISOBMFF brands that are images. */
const IMAGE_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'];
const AUDIO_BRANDS = ['M4A ', 'M4B ', 'isom', 'mp41', 'mp42', 'iso2', 'dash'];

/**
 * @typedef {Object} SniffedMedia
 * @property {'image'|'audio'} kind
 * @property {string} mimeType - Canonical media type.
 * @property {string} container - Short container name (`png`, `jpeg`, `wav`, ...).
 */

/**
 * Detect the kind and type of a media file from its first bytes.
 *
 * @param {Buffer} buffer
 * @returns {SniffedMedia|null} Null for an unknown or refused type.
 */
export function sniffMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && ascii(buffer, 1, 4) === 'PNG') {
    return { kind: 'image', mimeType: 'image/png', container: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg', container: 'jpeg' };
  }
  const head4 = ascii(buffer, 0, 4);
  if (head4 === 'GIF8') return { kind: 'image', mimeType: 'image/gif', container: 'gif' };
  if (head4 === 'RIFF') {
    const form = ascii(buffer, 8, 12);
    if (form === 'WEBP') return { kind: 'image', mimeType: 'image/webp', container: 'webp' };
    if (form === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav', container: 'wav' };
    return null;
  }
  if (ascii(buffer, 0, 2) === 'BM') {
    // A bare "BM" is weak evidence; require a plausible BMP header size field.
    if (buffer.readUInt32LE(2) <= buffer.length + 4) {
      return { kind: 'image', mimeType: 'image/bmp', container: 'bmp' };
    }
  }
  if (head4 === 'II*\0' || head4 === 'MM\0*') {
    return { kind: 'image', mimeType: 'image/tiff', container: 'tiff' };
  }
  if (head4 === 'fLaC') return { kind: 'audio', mimeType: 'audio/flac', container: 'flac' };
  if (head4 === 'OggS') return { kind: 'audio', mimeType: 'audio/ogg', container: 'ogg' };
  if (ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    if (IMAGE_BRANDS.includes(brand)) {
      const avif = brand.startsWith('avi');
      return {
        kind: 'image',
        mimeType: avif ? 'image/avif' : 'image/heic',
        container: avif ? 'avif' : 'heic'
      };
    }
    if (AUDIO_BRANDS.includes(brand)) {
      return { kind: 'audio', mimeType: 'audio/mp4', container: 'm4a' };
    }
    return null;
  }
  if (head4.startsWith('ID3')) return { kind: 'audio', mimeType: 'audio/mpeg', container: 'mp3' };
  // MPEG audio frame sync: 11 set bits.
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { kind: 'audio', mimeType: 'audio/mpeg', container: 'mp3' };
  }
  return null;
}

/**
 * The PCM payload of a canonical WAV (the `data` chunk), or null when the
 * buffer is not a WAV with one. TTS records hash the raw `pcm_s16le` stream, so
 * a user who wraps that PCM in a WAV header still matches by the payload hash.
 *
 * @param {Buffer} buffer
 * @returns {Buffer|null}
 */
export function wavPayload(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (ascii(buffer, 0, 4) !== 'RIFF' || ascii(buffer, 8, 12) !== 'WAVE') return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = ascii(buffer, offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'data') {
      // A streamed WAV may declare 0 or 0xFFFFFFFF: take what is there.
      const end = size === 0 || size === 0xffffffff ? buffer.length : start + size;
      return buffer.subarray(start, Math.min(end, buffer.length));
    }
    offset = start + size + (size % 2);
  }
  return null;
}
