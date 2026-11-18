// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Worker } from 'node:worker_threads';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { threadResourceLimits } from '../../utils/workerSizing.js';
import { projectSettings } from '../projects/projectSettings.js';
import { createIndexCache, searchIndex } from './corpusSearch.js';

/**
 * A few worker threads that build and search project corpus indexes off the
 * event loop. Load tests (1,000 users, 6 workers) showed BM25 ranking, prefix
 * expansion and excerpt token counting blocking the loop for up to 650 ms.
 *
 * Each thread owns the indexes of the projects routed to it — a project always
 * goes to the same thread (a hash of its id) — so a query sends a cache key, the
 * question and a few numbers, and gets the ranked hits back (a few KB, at most
 * the result budget). Only when the thread does not hold the index (first use,
 * changed items, eviction, a replaced thread) are the project's texts sent, once,
 * to build it. The cache limits (`projects.indexCache`) are split evenly across
 * the threads.
 *
 * Messages carry an id and the thread answers them in order, so its own message
 * queue is the job queue. A thread that crashes or runs out of memory fails the
 * jobs it held and is replaced on the next search (with an empty cache: the next
 * search of each of its projects rebuilds). No time budget: unlike file
 * extraction the work is bounded by the text the project holds.
 *
 * `projects.search.threads` sets the threads per server process (default 2; each
 * cluster worker has its own); `0`, a thread that cannot be started (or fails
 * {@link MAX_LOAD_FAILURES} times in a row before answering), or a shutdown
 * runs the same code on the event loop as before. Lowering the setting stops
 * the threads above it once they are idle. A thread's heap is capped like an
 * extraction thread's (`projects.extraction.memoryMb`).
 *
 * @module services/knowledge/searchPool
 */

const WORKER_URL = new URL('./searchWorker.js', import.meta.url);
/** Threads failing in a row before their first answer, after which searches run inline. */
const MAX_LOAD_FAILURES = 3;

/** The cache the event loop uses when no thread does the work. */
const inlineCache = createIndexCache();
/** Thread slots by index; a hole is a thread not started (or replaced) yet. */
const slots = [];
let nextJobId = 0;
let override = null;
let workerUrl = WORKER_URL;
let closed = false;
/** Threads that failed in a row without ever answering (a load failure, not a job's). */
let loadFailures = 0;

/** Search threads per process: the override, else `projects.search.threads`. */
export function searchThreads() {
  if (override !== null) return override;
  return projectSettings(configCache.getPlatform?.() || {}).search.threads;
}

/**
 * Replace the thread count (tests). Pass `null` to read platform.json again.
 *
 * @param {{threads: number, workerUrl?: URL}|null} settings - `workerUrl`
 *   replaces the thread's entry (tests of a thread that fails to load)
 */
export function configureSearchPool(settings) {
  override = settings ? settings.threads : null;
  workerUrl = settings?.workerUrl || WORKER_URL;
  closed = false;
  loadFailures = 0;
}

/** The thread a project's indexes live on. */
function slotIndexFor(projectId, threads) {
  let hash = 0;
  for (const char of String(projectId)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % threads;
}

function failure(message) {
  return Object.assign(new Error(message), { code: 'SEARCH_THREAD_FAILED' });
}

function spawn(index) {
  const { memoryMb } = projectSettings(configCache.getPlatform?.() || {}).extraction;
  const worker = new Worker(workerUrl, { resourceLimits: threadResourceLimits(memoryMb) });
  const slot = { worker, pending: new Map(), size: { entries: 0, chars: 0 }, answered: false };
  worker.on('message', ({ id, ok, result, error }) => {
    slot.answered = true;
    loadFailures = 0;
    const job = slot.pending.get(id);
    if (!job) return;
    slot.pending.delete(id);
    if (slot.pending.size === 0) worker.unref();
    if (!ok) return job.reject(new Error(error?.message || 'The search failed'));
    slot.size = { entries: result.entries, chars: result.chars };
    job.resolve(result);
  });
  worker.on('error', error => {
    const memory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
    if (!memory && !slot.answered && slots[index] === slot) {
      loadFailures += 1;
      if (loadFailures === MAX_LOAD_FAILURES) {
        logger.warn('The search threads keep failing to start; searching on the event loop', {
          component: 'searchPool',
          error: error?.message || String(error)
        });
      }
    }
    retire(
      index,
      slot,
      failure(
        memory
          ? 'The search thread ran out of memory.'
          : `The search thread failed: ${error?.message || error}`
      )
    );
  });
  worker.on('exit', code =>
    retire(index, slot, failure(`The search thread exited (code ${code}).`))
  );
  // An idle thread must not keep the process alive; one with jobs does (`post`).
  worker.unref();
  slots[index] = slot;
  return slot;
}

/** Drop a thread that is gone or must go, and fail the jobs it held. */
function retire(index, slot, error) {
  if (slots[index] !== slot) return;
  slots[index] = undefined;
  slot.worker.removeAllListeners('message');
  // A listener stays so a late 'error' of the dying thread is not unhandled.
  slot.worker.on('error', () => {});
  slot.worker.terminate().catch(() => {});
  for (const job of slot.pending.values()) job.reject(error);
  slot.pending.clear();
}

function post(slot, payload) {
  const id = ++nextJobId;
  return new Promise((resolve, reject) => {
    slot.pending.set(id, { resolve, reject });
    slot.worker.ref();
    slot.worker.postMessage({ id, task: 'search', payload });
  });
}

/**
 * Rank a project's corpus (`corpusSearch.searchIndex`) on the project's thread,
 * or on the event loop when the pool is off or its thread cannot be started.
 *
 * @param {string} projectId - Picks the thread
 * @param {Object} request - `searchIndex`'s request; `limits` are the process's
 *   and are split across the threads here
 * @returns {Promise<ReturnType<typeof searchIndex>>}
 * @throws {Error} `code: 'SEARCH_THREAD_FAILED'` when the thread died with the job
 */
export async function searchProjectIndex(projectId, request) {
  const threads = closed || loadFailures >= MAX_LOAD_FAILURES ? 0 : searchThreads();
  stopThreadsAbove(threads);
  if (threads > 0) {
    const index = slotIndexFor(projectId, threads);
    let slot = slots[index];
    if (!slot) {
      try {
        slot = spawn(index);
      } catch (error) {
        logger.warn('A search thread could not be started; searching on the event loop', {
          component: 'searchPool',
          error: error.message
        });
      }
    }
    if (slot) {
      const { maxEntries, maxChars } = request.limits;
      return post(slot, {
        ...request,
        limits: {
          maxEntries: Math.max(1, Math.ceil(maxEntries / threads)),
          maxChars: Math.floor(maxChars / threads)
        }
      });
    }
  }
  return searchIndex(inlineCache, request);
}

/** Stop the idle threads at or above `threads` (the setting was lowered). */
function stopThreadsAbove(threads) {
  for (let index = threads; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot && slot.pending.size === 0)
      retire(index, slot, failure('The search thread is no longer used.'));
  }
}

/** Forget a project's cached indexes (or all of them) here and on every thread. */
export function evictSearchIndexes(projectId) {
  inlineCache.evictProject(projectId);
  for (const slot of slots) {
    slot?.worker.postMessage({ task: 'evict', payload: { projectId } });
  }
}

/**
 * Indexes cached in this process: on the event loop, and on each thread as it
 * last reported (an eviction shows at the thread's next answer).
 *
 * @returns {{entries: number, chars: number}}
 */
export function searchCacheSize() {
  const total = inlineCache.size();
  for (const slot of slots) {
    if (!slot) continue;
    total.entries += slot.size.entries;
    total.chars += slot.size.chars;
  }
  return total;
}

/** Threads running and jobs they hold, for tests and diagnostics. */
export function searchPoolStats() {
  const live = slots.filter(Boolean);
  return {
    threads: live.length,
    pending: live.reduce((sum, slot) => sum + slot.pending.size, 0)
  };
}

/** Stop the threads for a shutdown; jobs they held fail, later searches run inline. */
export async function shutdownSearchPool() {
  closed = true;
  const stopping = [];
  slots.forEach((slot, index) => {
    if (!slot) return;
    const { worker } = slot;
    retire(index, slot, failure('The server is shutting down.'));
    stopping.push(worker.terminate().catch(() => {}));
  });
  await Promise.all(stopping);
}
