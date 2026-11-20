// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Looks for known payloads in stored bytes: the tool behind "nothing readable
 * in the bucket" checks.
 *
 * A scanner is built for one marker string and one block of random bytes. The
 * test writes both through the product and hands every stored object (and
 * every object name) to {@link ReadableScanner#find}.
 *
 * @module tests/support/readableScanner
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/** Shannon entropy of a buffer, in bits per byte (8 is random). */
export function entropy(buffer) {
  if (buffer.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of buffer) counts[byte] += 1;
  let bits = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Create a scanner with a fresh marker and fresh random bytes.
 *
 * @param {Object} [options]
 * @param {number} [options.randomBytes=65536] - Size of the binary payload.
 * @param {number} [options.windowStep=256] - Distance between the 16-byte
 *   windows of the binary payload that are searched for.
 * @returns {{marker: string, random: Buffer, payloads: () => Object<string, Buffer>,
 *   find: (stored: Buffer) => string[]}}
 *
 * @example
 * const scanner = createReadableScanner();
 * await blobs.put(ns, 'k', scanner.payloads().text);
 * assert.deepEqual(scanner.find(rawBytesOfTheObject), []);
 */
export function createReadableScanner({ randomBytes = 64 * 1024, windowStep = 256 } = {}) {
  const marker = `IHUB-PLAINTEXT-CANARY-${crypto.randomBytes(8).toString('hex')}`;
  const random = crypto.randomBytes(randomBytes);
  const needles = {
    'marker (UTF-8)': Buffer.from(marker, 'utf8'),
    'marker (UTF-16LE)': Buffer.from(marker, 'utf16le'),
    // The first 24 characters: independent of how the tail is padded.
    'marker (base64)': Buffer.from(Buffer.from(marker).toString('base64').slice(0, 24)),
    'marker (hex)': Buffer.from(Buffer.from(marker).toString('hex'))
  };
  return {
    marker,
    random,
    /** One payload per kind of content a blob holds. */
    payloads: () => ({
      text: Buffer.from(`${marker} `.repeat(200), 'utf8'),
      utf16: Buffer.from(`${marker} in UTF-16`, 'utf16le'),
      json: Buffer.from(JSON.stringify({ sha: { text: marker, note: 'evidence pack' } }), 'utf8'),
      binary: random,
      gzip: zlib.gzipSync(Buffer.from(`${marker} compressed`, 'utf8')),
      empty: Buffer.alloc(0)
    }),
    /**
     * Every way a payload shows in stored bytes.
     *
     * @param {Buffer} stored - Raw object bytes, or an object name as bytes.
     * @returns {string[]} What was found; empty when nothing is readable.
     */
    find(stored) {
      const found = [];
      for (const [name, needle] of Object.entries(needles)) {
        if (stored.includes(needle)) found.push(name);
      }
      for (let offset = 0; offset + 16 <= random.length; offset += windowStep) {
        if (stored.includes(random.subarray(offset, offset + 16))) {
          found.push('random payload bytes');
          break;
        }
      }
      try {
        if (zlib.gunzipSync(stored).includes(marker)) found.push('marker (gzip)');
      } catch {
        // Not gzip.
      }
      return found;
    }
  };
}
