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
 * Time in which the consumer does not read is not counted by either, and it
 * is not judged by the client's socket timeout (`requestTimeoutMs`) either:
 * that timer runs whenever the socket is idle, and the socket is idle while
 * the consumer drains what it has. A reader on a slow link, or a download the
 * browser paused, would be cut as "endpoint unreachable". The stream
 * therefore takes the socket's idle timer off while its reader is not asking
 * for data and puts it back when it asks again. What bounds a reader that
 * takes nothing is a bound of its own:
 *
 * - **Abandoned** (`abandonedMs`): the consumer asked for nothing for this
 *   long. The stream fails with `READ_ABANDONED`, which names the reader and
 *   not the bucket, and the connection is released. This is what frees the
 *   socket of a stream nobody reads or destroys.
 *
 * The stream ends only after exactly the declared number of bytes arrived; a
 * body that is cut, or longer, fails. Destroying the stream destroys the
 * response body and with it the connection, so nothing is downloaded for a
 * consumer that left.
 *
 * @module storage/providers/s3/s3BodyStream
 */
import { Readable } from 'node:stream';

/** How often the socket's idle timer is taken off again while the reader is away. */
const SOCKET_KEEPER_MS = 1000;

/**
 * Wrap a response body.
 *
 * @param {import('node:stream').Readable} body - `GetObject`'s `Body`.
 * @param {Object} options
 * @param {number} options.bytes - The declared `Content-Length`.
 * @param {number|null} [options.idleMs] - Longest wait for the next byte; null for none.
 * @param {number|null} [options.budgetMs] - Longest total wait; null for none.
 * @param {number|null} [options.abandonedMs] - Longest time the consumer may
 *   take nothing; null for none.
 * @param {number|null} [options.socketIdleMs] - The idle timeout the client
 *   put on the body's socket, restored while the consumer reads; null leaves
 *   the socket alone.
 * @param {(message: string) => Error} [options.abandonedError] - Builds the
 *   error for a consumer that took nothing for `abandonedMs`. Must not be an
 *   error `mapError` reports as a failure of the bucket.
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
  {
    bytes,
    idleMs = null,
    budgetMs = null,
    abandonedMs = null,
    socketIdleMs = null,
    mapError,
    timeoutError,
    lengthError,
    abandonedError = timeoutError
  }
) {
  let received = 0;
  let waiting = false;
  let waitedMs = 0;
  let waitingSince = 0;
  let idleTimer = null;
  let budgetTimer = null;
  let finished = false;

  /** True while the consumer is not asking for data. */
  let readerAway = false;
  let abandonedTimer = null;
  let socketKeeper = null;

  const socketIdleOff = () => {
    if (socketIdleMs !== null) body.socket?.setTimeout(0);
  };
  /**
   * The consumer stopped asking: its time is its own. The socket's idle timer
   * is taken off, and kept off: the client arms it up to a few seconds after
   * the request started, which can be after this.
   */
  const readerLeft = () => {
    if (readerAway || finished) return;
    readerAway = true;
    socketIdleOff();
    if (socketIdleMs !== null && body.socket) {
      socketKeeper = setInterval(socketIdleOff, SOCKET_KEEPER_MS);
      socketKeeper.unref?.();
    }
    if (abandonedMs !== null) {
      abandonedTimer = setTimeout(
        () => fail(abandonedError(`The reader took nothing for ${abandonedMs} ms`)),
        abandonedMs
      );
      abandonedTimer.unref?.();
    }
  };
  /** The consumer asks again (or the stream is over): the bucket is on the clock. */
  const readerBack = () => {
    if (!readerAway) return;
    readerAway = false;
    clearInterval(socketKeeper);
    clearTimeout(abandonedTimer);
    socketKeeper = null;
    abandonedTimer = null;
    if (socketIdleMs !== null && !finished) body.socket?.setTimeout(socketIdleMs);
  };

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
    readerBack();
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
      readerBack();
      startWaiting();
      body.resume();
    },
    destroy(error, callback) {
      finished = true;
      stopWaiting();
      readerBack();
      // Ends the request: the socket is closed, not returned to the pool with
      // an unread body on it.
      body.destroy();
      callback(error);
    }
  });

  // Paused before the listener goes on, so nothing flows until it is asked for.
  body.pause();
  readerLeft();
  body.on('data', chunk => {
    if (finished) return;
    received += chunk.length;
    if (received > bytes) return void fail(lengthError(`more than ${bytes} bytes arrived`));
    idleTimer?.refresh();
    if (!stream.push(chunk)) {
      stopWaiting();
      body.pause();
      readerLeft();
    }
  });
  body.once('end', () => {
    if (finished) return;
    if (received !== bytes) return void fail(lengthError(`${received} of ${bytes} bytes arrived`));
    finished = true;
    stopWaiting();
    readerBack();
    stream.push(null);
  });
  body.once('error', fail);
  // A connection that closes without an end and without an error.
  body.once('close', () => fail(lengthError(`${received} of ${bytes} bytes arrived`)));
  return stream;
}
