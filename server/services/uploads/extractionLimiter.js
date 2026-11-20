// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cap on how many uploaded files are read (scanned and extracted) at the
 * same time in one server process.
 *
 * An upload waits on disk (`uploadSpool.js`); reading it needs the whole file
 * in memory, because every extractor takes a `Buffer`. Without a cap, twenty
 * parallel uploads of 25 MB held twenty buffers at once. With it, at most
 * `uploads.extraction.concurrency` files are in memory, up to
 * `uploads.extraction.maxQueue` more wait (as spool files, not as buffers),
 * and one more than that is refused with {@link ExtractionBusyError}: a
 * retryable `503` with `Retry-After`.
 *
 * The cap is per process. Project uploads share it but never get the refusal:
 * their extraction runs after the request was answered (`202`), so their jobs
 * wait for a slot however long the queue is (`wait: 'always'`); the project
 * ingest queue bounds those jobs itself.
 *
 * @module services/uploads/extractionLimiter
 */
import configCache from '../../configCache.js';

/** Files read at the same time when `uploads.extraction.concurrency` is not set. */
export const DEFAULT_EXTRACTION_CONCURRENCY = 2;

/** Uploads waiting for a slot when `uploads.extraction.maxQueue` is not set. */
export const DEFAULT_EXTRACTION_MAX_QUEUE = 50;

/** Bounds of the `Retry-After` a refused upload is given. */
const MIN_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 60 * 1000;

/** What one extraction is assumed to take before any was measured. */
const INITIAL_RUN_MS = 1000;

/** The queue is full: the caller should try again after `retryAfterMs`. */
export class ExtractionBusyError extends Error {
  /** @param {number} retryAfterMs */
  constructor(retryAfterMs) {
    super('The server is reading other uploaded files. Try again in a moment.');
    this.name = 'ExtractionBusyError';
    this.code = 'UPLOAD_BUSY';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The caller stopped waiting (its request was closed) before it got a slot. */
export class ExtractionAbortedError extends Error {
  constructor() {
    super('The upload was cancelled before the file was read.');
    this.name = 'ExtractionAbortedError';
    this.code = 'UPLOAD_ABORTED';
  }
}

function positiveInteger(value, fallback, { min = 0 } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback;
}

/**
 * The effective `uploads.extraction` settings.
 *
 * @param {Object} [platform] - `platform.json`; read from the config cache when left out.
 * @returns {{concurrency: number, maxQueue: number}}
 */
export function extractionLimits(platform = configCache.getPlatform?.() || {}) {
  const block = platform?.uploads?.extraction || {};
  return {
    concurrency: positiveInteger(block.concurrency, DEFAULT_EXTRACTION_CONCURRENCY, { min: 1 }),
    maxQueue: positiveInteger(block.maxQueue, DEFAULT_EXTRACTION_MAX_QUEUE, { min: 0 })
  };
}

/**
 * A counting semaphore with a bounded wait queue.
 */
export class ExtractionLimiter {
  /**
   * @param {Object} [options]
   * @param {() => {concurrency: number, maxQueue: number}} [options.limits] - Read on every
   *   call, so a changed configuration applies without a restart.
   */
  constructor({ limits = extractionLimits } = {}) {
    this._limits = limits;
    this.running = 0;
    /** @type {Array<{start: Function, bounded: boolean}>} */
    this.waiting = [];
    /** Moving average of how long a slot was held, for `Retry-After`. */
    this.averageRunMs = INITIAL_RUN_MS;
  }

  /** Slots in use and callers waiting, for tests and diagnostics. */
  stats() {
    return {
      running: this.running,
      queued: this.waiting.length,
      ...this._limits()
    };
  }

  /** When a refused caller may expect a free place in the queue. */
  _retryAfterMs(concurrency) {
    const ahead = this.waiting.length + this.running;
    const estimate = (this.averageRunMs * ahead) / Math.max(1, concurrency);
    return Math.round(Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, estimate)));
  }

  _pump() {
    const { concurrency } = this._limits();
    while (this.running < concurrency && this.waiting.length > 0) {
      this.running += 1;
      this.waiting.shift().start();
    }
  }

  /**
   * Run `task` in a slot: at once when one is free, else after waiting in the
   * queue. The slot is released when `task` settles, also when it throws.
   *
   * @template T
   * @param {() => Promise<T>|T} task
   * @param {Object} [options]
   * @param {'bounded'|'always'} [options.wait='bounded'] - `bounded`: refuse when
   *   `maxQueue` callers wait already. `always`: wait however long the queue is
   *   (background work that cannot be answered with "try again").
   * @param {AbortSignal} [options.signal] - Stop waiting; a running task is not interrupted.
   * @returns {Promise<T>}
   * @throws {ExtractionBusyError} The queue is full (`wait: 'bounded'` only).
   * @throws {ExtractionAbortedError} `signal` fired while waiting.
   */
  async run(task, { wait = 'bounded', signal } = {}) {
    if (signal?.aborted) throw new ExtractionAbortedError();
    const { concurrency, maxQueue } = this._limits();
    const free = this.running < concurrency && this.waiting.length === 0;
    if (!free && wait !== 'always') {
      const bounded = this.waiting.filter(entry => entry.bounded).length;
      if (bounded >= maxQueue) throw new ExtractionBusyError(this._retryAfterMs(concurrency));
    }
    if (free) {
      this.running += 1;
    } else {
      await new Promise((resolve, reject) => {
        const entry = { bounded: wait !== 'always', start: null };
        const onAbort = () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(new ExtractionAbortedError());
        };
        entry.start = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(entry);
        // The limit may have been raised since the last release.
        this._pump();
      });
    }
    const started = Date.now();
    try {
      return await task();
    } finally {
      this.averageRunMs = this.averageRunMs * 0.8 + (Date.now() - started) * 0.2;
      this.running -= 1;
      this._pump();
    }
  }
}

let shared = null;

/** The process-wide limiter every upload path shares. */
export function getExtractionLimiter() {
  if (!shared) shared = new ExtractionLimiter();
  return shared;
}

/** Replace the process-wide limiter (tests); `null` restores the default. */
export function setExtractionLimiter(limiter) {
  shared = limiter;
}
