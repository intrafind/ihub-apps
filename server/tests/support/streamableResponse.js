// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Lets a hand-written response double take a streamed body.
 *
 * Route tests that drive a handler chain directly use a plain object for
 * `res` (`status`, `json`, `send`, `setHeader`). A route that streams a blob
 * (`utils/streamResponse.js`) pipes into the response and listens for
 * `finish` and `close`, which a plain object does not have. This gives the
 * double a real `Writable` to stand on: what is piped into it ends up in
 * `res.body` as one Buffer, as `res.send(buffer)` would leave it.
 *
 * @module tests/support/streamableResponse
 */
import { Writable } from 'node:stream';

/**
 * Add the stream side of a response to a double, in place.
 *
 * - `res.body` is the piped bytes once the stream ended.
 * - `res.headersSent` turns true with the first chunk.
 * - `res.destroy(error)` records `res.destroyedWith` and marks the double
 *   `aborted`, which is what a client sees as a broken download.
 * - `res.end()` without a piped body stays what the double had.
 *
 * @param {Object} res - The double; needs no stream method of its own.
 * @returns {Object} The same object.
 */
export function makeStreamable(res) {
  const chunks = [];
  let piped = false;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      res.headersSent = true;
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      if (piped || chunks.length > 0) res.body = Buffer.concat(chunks);
      callback();
    }
  });
  sink.on('pipe', () => {
    piped = true;
  });
  sink.on('error', () => {});
  for (const name of [
    'on',
    'once',
    'off',
    'emit',
    'removeListener',
    'prependListener',
    'listenerCount',
    'write'
  ]) {
    res[name] = sink[name].bind(sink);
  }
  const end = res.end;
  res.headersSent = false;
  res.aborted = false;
  res.end = (...args) => {
    sink.end();
    return typeof end === 'function' ? end(...args) : res;
  };
  res.destroy = error => {
    res.aborted = true;
    res.destroyedWith = error || null;
    sink.destroy(error);
    return res;
  };
  Object.defineProperty(res, 'writableFinished', { get: () => sink.writableFinished });
  Object.defineProperty(res, 'destroyed', { get: () => sink.destroyed });
  return res;
}
