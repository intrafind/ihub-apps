/**
 * Abort helpers shared by the runtime: settle a piece of work as soon as its
 * signal aborts, even when the work itself ignores the signal (a hanging
 * request builder or tool must not outlive the call's deadline).
 *
 * @module services/loop/abortRace
 */

/** An error the runtime recognizes as an abort (`isAbortError`). */
export function abortError(message = 'Aborted') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

/**
 * Run `start()` and reject the moment `signal` aborts. Without a signal the
 * work simply runs.
 *
 * @param {() => Promise<any>|any} start
 * @param {AbortSignal|null|undefined} signal
 * @param {() => Error} [makeError] - builds the rejection (default: a plain AbortError)
 * @returns {Promise<any>}
 */
export function raceAbort(start, signal, makeError = () => abortError()) {
  if (!signal) return Promise.resolve().then(start);
  if (signal.aborted) return Promise.reject(makeError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(start)
      .then(
        value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        err => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
  });
}
