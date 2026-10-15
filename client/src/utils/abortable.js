/**
 * Helpers for long browser-side jobs that can be stopped with an AbortSignal:
 * extracting the audio of a video, encoding a WAV.
 *
 * What stopping rejects with is an Error named `AbortError` whose message and
 * `code` are both `'aborted'`. Callers tell it from a failure with
 * `isAbortError()` and show nothing: the user asked for it.
 */

export const createAbortError = () =>
  Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' });

export const isAbortError = error => error?.code === 'aborted' || error?.name === 'AbortError';

/** Throw the abort error if `signal` has fired. */
export const throwIfAborted = signal => {
  if (signal?.aborted) throw createAbortError();
};

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
