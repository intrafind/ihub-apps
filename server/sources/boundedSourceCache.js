// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cache of a source handler, bounded by entry count and estimated bytes.
 *
 * A source handler's cache used to be a plain `Map` whose entries only went
 * away when their TTL had passed *and* the same key was asked for again — so a
 * worker that read many distinct pages kept every one of them for the life of
 * the process (#3624). This is still a `Map` (handlers and subclasses read and
 * delete entries directly), but every `set` evicts the oldest entries until the
 * cache is within both bounds again, and an entry larger than the whole byte
 * bound is not cached at all.
 *
 * @module sources/boundedSourceCache
 */

/** Rough per-entry overhead (the entry object, timestamps, Map slot). */
const ENTRY_OVERHEAD_BYTES = 256;

/** How deep the size estimate walks an entry. */
const MAX_DEPTH = 4;

/**
 * Estimated heap bytes of a value: strings at two bytes a character, plus a
 * little per object, walked a few levels deep.
 *
 * @param {unknown} value - Cached value
 * @param {number} [depth=0] - Current depth
 * @returns {number}
 */
function estimateBytes(value, depth = 0) {
  if (typeof value === 'string') return value.length * 2;
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return 8;
  let bytes = 16;
  for (const member of Object.values(value)) bytes += estimateBytes(member, depth + 1);
  return bytes;
}

export class BoundedSourceCache extends Map {
  /**
   * @param {Object} limits
   * @param {number} limits.maxEntries - Most entries kept
   * @param {number} limits.maxBytes - Most estimated bytes kept
   */
  constructor({ maxEntries, maxBytes }) {
    super();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    /** Estimated bytes of the entries held. */
    this.bytes = 0;
    this._sizes = new Map();
  }

  /**
   * Store an entry as the newest, then evict the oldest until both bounds hold.
   *
   * @param {string} key - Cache key
   * @param {Object} value - Cache entry
   * @returns {this}
   */
  set(key, value) {
    this.delete(key);
    const size = ENTRY_OVERHEAD_BYTES + String(key).length * 2 + estimateBytes(value);
    if (size > this.maxBytes) return this;
    super.set(key, value);
    this._sizes.set(key, size);
    this.bytes += size;
    while (this.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.keys().next().value);
    }
    return this;
  }

  /** @param {string} key @returns {boolean} */
  delete(key) {
    if (!super.has(key)) return false;
    this.bytes -= this._sizes.get(key) || 0;
    this._sizes.delete(key);
    return super.delete(key);
  }

  clear() {
    super.clear();
    this._sizes.clear();
    this.bytes = 0;
  }
}

export default BoundedSourceCache;
