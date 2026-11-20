// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Envelope version 1 (`./blobEnvelope.js`) as Node streams: the same bytes the
 * buffered `encrypt` and `decrypt` of `./streamingAead.js` read and write,
 * sealed or opened one 1 MiB segment at a time. Used by the encrypting blob
 * store (`storage/EncryptingBlobStore.js`) and by the sealed files of the
 * stores outside the storage layer (`storage/atRest/sealedFiles.js`).
 *
 * Memory is bounded by the segment size, not by the object: an opening stream
 * holds one segment of ciphertext and hands out one segment of plaintext, a
 * sealing stream holds one segment of plaintext.
 *
 * **What a reader of an opening stream may rely on, and what it may not.**
 * Every chunk it receives was authenticated for its position before it was
 * handed out. That the object is *complete* is known only when the stream
 * ends: a stream that fails (`'error'`) after it handed out data has shown a
 * true prefix of the content, and whoever passed that prefix on has to make
 * the failure visible downstream. A stream never ends cleanly on a cut or
 * changed object.
 *
 * This module does no I/O and reads no key: the caller unwraps the data key.
 *
 * @module crypto/envelopeStreams
 */
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { ENVELOPE_SEGMENT_BYTES } from './blobEnvelope.js';
import { StreamingAeadError, createDecryptor, createEncryptor } from './streamingAead.js';

/**
 * How an opening stream reads what follows the head.
 *
 * @typedef {Object} OpeningPlan
 * @property {boolean} [passthrough] - The object is not an envelope and is
 *   handed out as stored, head included.
 * @property {Buffer} [dataKey] - The unwrapped data key. The stream wipes it
 *   when it is done or destroyed.
 * @property {Buffer|string} [aad] - Associated data of the object.
 * @property {number|null} [expectedBytes] - Plaintext length the envelope's
 *   stored length stands for. A stream that verifies but has another length
 *   fails.
 */

/**
 * A stream that opens an envelope: stored bytes in, content out.
 *
 * The first `headBytes` bytes are collected and given to `begin`, which
 * decides how the rest is read (and unwraps the data key). The content of a
 * segment is pushed only after its tag verified.
 *
 * `ready` settles once it is known that the stream delivers: it resolves when
 * the first verified segment was pushed (or the stream ended, for a content
 * that fits one segment), and rejects with the stream's error when the head,
 * the key or the first segment fail. A caller awaits it before it promises
 * anything to its own consumer; failures after that reach the consumer as the
 * stream's `'error'`.
 *
 * @param {Object} options
 * @param {number} [options.headBytes=0] - Bytes `begin` needs to see; 0 when
 *   the caller read the header itself and the stream starts at the ciphertext.
 * @param {(head: Buffer) => OpeningPlan|Promise<OpeningPlan>} options.begin -
 *   Called once, with the head (shorter than `headBytes` when the object is).
 *   What it throws becomes the stream's error.
 * @param {(error: Error) => Error} [options.mapError] - Translates a
 *   {@link StreamingAeadError} (and anything else thrown while opening) into
 *   the error the stream fails with.
 * @returns {import('node:stream').Transform & {ready: Promise<void>}}
 *
 * @example
 * const opening = createOpeningStream({ begin: () => ({ dataKey, aad, expectedBytes }) });
 * pipeline(fs.createReadStream(file, { start: ENVELOPE_HEADER_BYTES }), opening, () => {});
 * await opening.ready; // throws when the file does not open
 * opening.pipe(response);
 */
export function createOpeningStream({ headBytes = 0, begin, mapError = error => error }) {
  const head = [];
  let headLength = 0;
  let started = false;
  let passthrough = false;
  let decryptor = null;
  let dataKey = null;
  let expected = null;
  let produced = 0;
  let announced = false;
  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller awaits `ready`; a stream destroyed without anyone waiting must
  // not surface as an unhandled rejection.
  ready.catch(() => {});
  const announce = () => {
    if (announced) return;
    announced = true;
    settle.resolve();
  };

  /** Decide how to read, and return what of the collected bytes is content. */
  const start = async () => {
    const collected = head.length === 1 ? head[0] : Buffer.concat(head, headLength);
    head.length = 0;
    const cut = Math.min(headBytes, collected.length);
    const plan = (await begin(collected.subarray(0, cut))) || {};
    if (stream.destroyed) {
      // Closed while the key was unwrapped: nobody is left to wipe it.
      plan.dataKey?.fill(0);
      throw new Error('The stream was closed before it was opened');
    }
    started = true;
    if (plan.passthrough) {
      passthrough = true;
      return collected;
    }
    dataKey = plan.dataKey;
    expected = Number.isSafeInteger(plan.expectedBytes) ? plan.expectedBytes : null;
    decryptor = createDecryptor(dataKey, plan.aad, { segmentBytes: ENVELOPE_SEGMENT_BYTES });
    return collected.subarray(cut);
  };

  /** Hand on what a piece of stored bytes yields. Throws when a segment does not verify. */
  const feed = (stream, chunk) => {
    if (passthrough) {
      if (chunk.length === 0) return;
      stream.push(chunk);
      announce();
      return;
    }
    for (const piece of decryptor.update(chunk)) {
      produced += piece.length;
      stream.push(piece);
      announce();
    }
  };

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      if (started) {
        try {
          feed(this, chunk);
        } catch (error) {
          return void callback(mapError(error));
        }
        return void callback();
      }
      head.push(chunk);
      headLength += chunk.length;
      if (headLength < headBytes) return void callback();
      start()
        .then(rest => feed(this, rest))
        .then(
          () => callback(),
          error => callback(mapError(error))
        );
      return undefined;
    },
    flush(callback) {
      (async () => {
        if (!started) feed(this, await start());
        if (!passthrough) {
          const last = decryptor.final();
          const total = last.reduce((sum, piece) => sum + piece.length, produced);
          // Checked before the last segment is handed on.
          if (expected !== null && total !== expected) {
            throw new StreamingAeadError('The content has another length than its envelope');
          }
          for (const piece of last) this.push(piece);
        }
        announce();
      })().then(
        () => callback(),
        error => callback(mapError(error))
      );
    },
    destroy(error, callback) {
      decryptor?.destroy();
      dataKey?.fill(0);
      if (!announced) {
        announced = true;
        settle.reject(error || new Error('The stream was closed before it was opened'));
      }
      callback(error);
    }
  });
  stream.ready = ready;
  return stream;
}

/**
 * A stream that seals content into an envelope: content in, header and
 * ciphertext out, as `encodeHeader` and the buffered `encrypt` would lay them
 * out for the same content.
 *
 * The content length is declared up front, because the stored length follows
 * from it (`storedLength`) and a backend may need it before the first byte. A
 * source that delivers more or fewer bytes makes the stream fail.
 *
 * @param {Object} options
 * @param {Buffer} options.header - The encoded envelope header (512 bytes).
 * @param {Buffer} options.dataKey - The data key the header wraps. Not wiped
 *   here: the caller owns it.
 * @param {Buffer|string} options.aad - Associated data of the object.
 * @param {number} options.bytes - Declared content length.
 * @param {(arrived: number) => Error} [options.lengthError] - The error for a
 *   source that does not deliver `bytes` bytes.
 * @returns {import('node:stream').Transform & {result: () => {bytes: number, sha256: string|null}}}
 *   `result()` gives the content's length and SHA-256 once the stream ended.
 */
export function createSealingStream({ header, dataKey, aad, bytes, lengthError }) {
  const encryptor = createEncryptor(dataKey, aad, { segmentBytes: ENVELOPE_SEGMENT_BYTES });
  const hash = crypto.createHash('sha256');
  const wrongLength = arrived =>
    lengthError?.(arrived) ||
    new StreamingAeadError(`The content has ${arrived} bytes, ${bytes} were declared`);
  let count = 0;
  let headerSent = false;
  let digest = null;

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        count += chunk.length;
        if (count > bytes) throw wrongLength(count);
        hash.update(chunk);
        if (!headerSent) {
          headerSent = true;
          this.push(header);
        }
        for (const piece of encryptor.update(chunk)) this.push(piece);
      } catch (error) {
        return void callback(error);
      }
      return void callback();
    },
    flush(callback) {
      try {
        if (count !== bytes) throw wrongLength(count);
        if (!headerSent) this.push(header);
        for (const piece of encryptor.final()) this.push(piece);
        digest = hash.digest('hex');
      } catch (error) {
        return void callback(error);
      }
      return void callback();
    },
    destroy(error, callback) {
      encryptor.destroy();
      callback(error);
    }
  });
  stream.result = () => ({ bytes: count, sha256: digest });
  return stream;
}
