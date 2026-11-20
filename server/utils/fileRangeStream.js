// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A read stream over a range of an open file that delivers exactly the bytes
 * of that range, or fails.
 *
 * A download announces its length before its first byte (`Content-Length`).
 * The length and the bytes must therefore come from the same open file: a
 * path that is looked at twice (`stat`, then `createReadStream`) can be
 * another file the second time, when the file was replaced by a rename in
 * between. And a file that turns out shorter than its `stat` said (something
 * truncated it) must not end the stream cleanly: the consumer would take the
 * cut content for the whole.
 *
 * `fs.createReadStream` with `end` covers neither: it ends silently at the
 * end of a shorter file.
 *
 * @module utils/fileRangeStream
 */
import { Readable } from 'node:stream';

const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Open a stream over bytes `start` to `end - 1` of an open file.
 *
 * The stream owns the handle from here on: it is closed when the stream
 * ended, failed or was destroyed.
 *
 * @param {import('node:fs/promises').FileHandle} handle - Open for reading.
 * @param {Object} options
 * @param {number} [options.start=0] - First byte.
 * @param {number} options.end - One past the last byte: the stream delivers
 *   `end - start` bytes.
 * @param {number} [options.chunkBytes=65536] - Largest chunk.
 * @param {(error: Error) => Error} [options.mapError] - Translates what the
 *   stream fails with (a read error, the short-file error with code
 *   `ERR_FILE_SHORTER_THAN_EXPECTED`).
 * @returns {import('node:stream').Readable} A byte stream; it carries an
 *   `'error'` listener, so a failure before the consumer listens is recorded
 *   on the stream and not thrown (see `guardStream` in `storage/blobSupport.js`).
 *
 * @example
 * const handle = await fs.open(file, 'r');
 * const { size } = await handle.stat();
 * const stream = fileRangeStream(handle, { end: size });
 */
export function fileRangeStream(
  handle,
  { start = 0, end, chunkBytes = DEFAULT_CHUNK_BYTES, mapError = error => error }
) {
  let position = start;
  let reading = false;
  const stream = new Readable({
    highWaterMark: chunkBytes,
    read() {
      if (reading) return;
      if (position >= end) return void this.push(null);
      reading = true;
      const want = Math.min(chunkBytes, end - position);
      handle.read(Buffer.allocUnsafe(want), 0, want, position).then(
        ({ bytesRead, buffer }) => {
          reading = false;
          if (this.destroyed) return;
          if (bytesRead === 0) {
            const short = new Error(
              `The file ended after ${position - start} of ${end - start} bytes`
            );
            short.code = 'ERR_FILE_SHORTER_THAN_EXPECTED';
            return void this.destroy(short);
          }
          position += bytesRead;
          this.push(buffer.subarray(0, bytesRead));
          if (position >= end) this.push(null);
        },
        error => {
          reading = false;
          this.destroy(error);
        }
      );
    },
    destroy(error, callback) {
      // `close` waits for a read that is under way.
      const done = () => callback(error ? mapError(error) : error);
      handle.close().then(done, done);
    }
  });
  stream.on('error', () => {});
  return stream;
}
