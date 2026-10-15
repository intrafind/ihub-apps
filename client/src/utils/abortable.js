import {
  createAbortError,
  isAbortError,
  throwIfAborted
} from '../../../shared/documentExtraction/progress.js';

/**
 * Helpers for long browser-side jobs that can be stopped with an AbortSignal:
 * extracting the audio of a video, encoding a WAV, extracting the text of a
 * document.
 *
 * What stopping rejects with is an Error named `AbortError` whose message and
 * `code` are both `'aborted'`. Callers tell it from a failure with
 * `isAbortError()` and show nothing: the user asked for it.
 */

// Defined next to the document extractors: `shared/` is also loaded by the server and cannot
// import from the client, but the client can import from it.
export { createAbortError, isAbortError, throwIfAborted };

/**
 * Settle with `promise` (or a plain value), or reject with the abort error as
 * soon as `signal` fires. Work behind a promise (decoding audio, rendering an
 * offline context) cannot be cancelled: it runs on to its end and its result
 * is dropped.
 */
export const raceAbort = (promise, signal) => {
  if (!signal) return promise;
  const work = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      work.catch(() => {});
      reject(createAbortError());
      return;
    }
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

/**
 * Give the browser a turn to handle input and paint between the slices of a
 * long job. A message port instead of `setTimeout(0)`: timers are held to one
 * run per second in a background tab, which would stretch a job the user
 * started and then switched away from by a second per slice.
 */
export const yieldToEventLoop = () =>
  new Promise(resolve => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
