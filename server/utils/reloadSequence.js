// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Keeps an older reload from putting its data over a newer one.
 *
 * Reloads of one cache entry overlap: the TTL timer, the storage provider's
 * change event, an admin save refreshing the entry, and an invalidation relayed
 * from another worker can all be running at once. Each reads the disk at its
 * own moment and stores its result when it is done, so one that started before a
 * write can finish after a reload that started after it, and, storing last,
 * replace the newer data with the older. The entry then stays stale until the
 * next reload, which for most entries is the 5-minute TTL.
 *
 * Reloads are numbered as they start. A reload may store only if no reload that
 * started later has stored already; a reload that finishes late is dropped, and
 * the one that overtook it holds the newer data.
 *
 * @module server/utils/reloadSequence
 */
export class ReloadSequence {
  /** key → number of the latest reload started */
  #started = new Map();
  /** key → number of the latest reload that stored (or found nothing to store) */
  #applied = new Map();

  /**
   * Number a reload of `key`. Call before reading anything.
   *
   * @param {string} key
   * @returns {number} The reload's ticket
   */
  begin(key) {
    const ticket = (this.#started.get(key) ?? 0) + 1;
    this.#started.set(key, ticket);
    return ticket;
  }

  /**
   * Ask whether the reload with `ticket` may store what it read. Call once it
   * has read, before storing. A reload that may store is recorded as the newest
   * applied, so every older one that is still running will be refused.
   *
   * @param {string} key
   * @param {number} ticket - From {@link ReloadSequence#begin}
   * @returns {boolean} False when a later-started reload has stored already
   */
  claim(key, ticket) {
    if (ticket < (this.#applied.get(key) ?? 0)) return false;
    this.#applied.set(key, ticket);
    return true;
  }
}
