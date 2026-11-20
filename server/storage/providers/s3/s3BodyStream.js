// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The body of a `GetObject` response as a stream with an end: what
 * `S3BlobStore.openRead` hands out.
 *
 * A buffered read has one deadline for the whole body. A stream is read at
 * the pace of its consumer (an HTTP client on a slow link), so its bounds
 * count only the time in which the consumer wants bytes and the bucket does
 * not deliver them:
 *
 * - **Idle time** (`idleMs`): no byte arrived for this long while one was
 *   wanted. A server that sends the headers and then stalls ends here.
 * - **Waiting time** (`budgetMs`): the time spent waiting for the bucket,
 *   added up over the whole read, is bounded by the call's deadline plus the
 *   time the object needs at the slowest accepted transfer rate. A body that
 *   only trickles ends here.
 *
 * Time in which the consumer does not read is not counted by either. It is
 * bounded by the client's socket timeout (`requestTimeoutMs`): a consumer
 * that takes nothing for that long loses the connection, which is also what
 * frees the socket of a stream nobody reads or destroys.
 *
 * The stream ends only after exactly the declared number of bytes arrived; a
 * body that is cut, or longer, fails. Destroying the stream destroys the
 * response body and with it the connection, so nothing is downloaded for a
 * consumer that left.
 *
 * @module storage/providers/s3/s3BodyStream
 */
import { Readable } from 'node:stream';

/**
 * Wrap a response body.
 *
 * @param {import('node:stream').Readable} body - `GetObject`'s `Body`.
 * @param {Object} options
 * @param {number} options.bytes - The declared `Content-Length`.
 * @param {number|null} [options.idleMs] - Longest wait for the next byte; null for none.
 * @param {number|null} [options.budgetMs] - Longest total wait; null for none.
 * @param {(error: Error) => Error} options.mapError - Translates a failure
 *   (a socket error, a timeout, a wrong length) into the error the stream
 *   fails with. Called once per stream.
 * @param {(message: string) => Error} options.timeoutError - Builds the error
 *   for a bound that passed.
 * @param {(message: string) => Error} options.lengthError - Builds the error
 *   for a body of another length than declared.
 * @returns {import('node:stream').Readable}
 */
export function boundedBodyStream(
  body,
  { bytes, idleMs = null, budgetMs = null, mapError, timeoutError, lengthError }
) {
  let received = 0;
  let waiting = false;
  let waitedMs = 0;
  let waitingSince = 0;
  let idleTimer = null;
  let budgetTimer = null;
  let finished = false;

  const stopTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(budgetTimer);
    idleTimer = null;
    budgetTimer = null;
  };
  const stopWaiting = () => {
    if (!waiting) return;
    waiting = false;
    waitedMs += Date.now() - waitingSince;
    stopTimers();
  };
  const fail = error => {
    if (finished) return;
    finished = true;
    stopWaiting();
    stream.destroy(mapError(error));
  };
  const startWaiting = () => {
    if (waiting || finished) return;
    waiting = true;
    waitingSince = Date.now();
    if (idleMs !== null) {
      idleTimer = setTimeout(
        () => fail(timeoutError(`The response body sent nothing for ${idleMs} ms`)),
        idleMs
      );
    }
    if (budgetMs !== null) {
      budgetTimer = setTimeout(
        () =>
          fail(timeoutError(`The response body did not arrive within ${budgetMs} ms of waiting`)),
        Math.max(1, budgetMs - waitedMs)
      );
    }
  };

  const stream = new Readable({
    read() {
      startWaiting();
      body.resume();
    },
    destroy(error, callback) {
      finished = true;
      stopWaiting();
      // Ends the request: the socket is closed, not returned to the pool with
      // an unread body on it.
      body.destroy();
      callback(error);
    }
  });

  // Paused before the listener goes on, so nothing flows until it is asked for.
  body.pause();
  body.on('data', chunk => {
    if (finished) return;
    received += chunk.length;
    if (received > bytes) return void fail(lengthError(`more than ${bytes} bytes arrived`));
    idleTimer?.refresh();
    if (!stream.push(chunk)) {
      stopWaiting();
      body.pause();
    }
  });
  body.once('end', () => {
    if (finished) return;
    if (received !== bytes) return void fail(lengthError(`${received} of ${bytes} bytes arrived`));
    finished = true;
    stopWaiting();
    stream.push(null);
  });
  body.once('error', fail);
  // A connection that closes without an end and without an error.
  body.once('close', () => fail(lengthError(`${received} of ${bytes} bytes arrived`)));
  return stream;
}
