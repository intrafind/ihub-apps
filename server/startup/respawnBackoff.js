// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How long the cluster primary waits before it replaces a worker that died.
 *
 * A worker that dies after serving for a while is replaced at once. A worker
 * that dies right after it was forked usually cannot start at all (storage
 * refuses, a broken configuration), and its replacement dies the same way:
 * forked again without a pause, that is a loop that burns a CPU core and
 * fills the log. Each early death therefore doubles the pause, from 1 s up to
 * 30 s; a worker that stays up for a minute resets it.
 *
 * @module startup/respawnBackoff
 */

/** A worker that lived at least this long died of something else than its start. */
export const STABLE_AFTER_MS = 60_000;

/** Pause after the first early death; doubled per further one. */
export const FIRST_DELAY_MS = 1000;

/** Longest pause. */
export const MAX_DELAY_MS = 30_000;

/**
 * A backoff shared by all worker slots of one primary.
 *
 * @param {Object} [options]
 * @param {number} [options.stableAfterMs=60000]
 * @param {number} [options.firstDelayMs=1000]
 * @param {number} [options.maxDelayMs=30000]
 * @returns {{next: (livedMs: number) => number, readonly earlyDeaths: number}}
 *   `next` takes how long the worker that just died was alive and answers the
 *   pause before its replacement is forked, in milliseconds (0: at once).
 *
 * @example
 * const backoff = createRespawnBackoff();
 * backoff.next(120000); // 0
 * backoff.next(300);    // 1000
 * backoff.next(250);    // 2000
 */
export function createRespawnBackoff({
  stableAfterMs = STABLE_AFTER_MS,
  firstDelayMs = FIRST_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS
} = {}) {
  let earlyDeaths = 0;
  return {
    next(livedMs) {
      if (!(livedMs < stableAfterMs)) {
        earlyDeaths = 0;
        return 0;
      }
      earlyDeaths += 1;
      return Math.min(maxDelayMs, firstDelayMs * 2 ** (earlyDeaths - 1));
    },
    get earlyDeaths() {
      return earlyDeaths;
    }
  };
}
