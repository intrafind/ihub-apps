import fs from 'fs/promises';
import path from 'path';
import logger from './logger.js';

/**
 * Create an append-only JSONL queue: entries are buffered in memory,
 * debounce-flushed to disk (grouped by resolved file path), with an unref'd
 * periodic safety-net flush, an optional overflow cap, and a write lock that
 * callers can use to serialize a flush against a read-modify-rewrite
 * (e.g. retention cleanup).
 *
 * Shared by feedbackStorage.js, services/UsageEventLog.js and
 * services/AuditLogService.js, which all queue entries and flush them to one
 * or more JSONL files on an interval.
 *
 * @param {Object} options
 * @param {(entry: any) => string} options.getFilePath - Resolves the target file for an entry (e.g. a fixed path, or a per-date path)
 * @param {number} [options.flushIntervalMs=10000] - Debounce/periodic-safety-net interval
 * @param {number|null} [options.maxQueueSize=null] - Drop-oldest cap; null disables the cap
 * @param {string} [options.component] - Logger component name for error messages
 */
export function createJsonlAppender({
  getFilePath,
  flushIntervalMs = 10000,
  maxQueueSize = null,
  component = 'JsonlAppender'
}) {
  let queue = [];
  let flushTimer = null;
  let overflowed = false;

  let writeLock = Promise.resolve();
  function withWriteLock(fn) {
    const prev = writeLock;
    let release;
    writeLock = new Promise(r => {
      release = r;
    });
    return prev.then(fn).finally(release);
  }

  // Drains the current queue to disk, grouped by resolved file path. Writes
  // each group independently and re-buffers only the groups that failed, so a
  // partial failure can't re-write (and thereby duplicate) entries that
  // already landed. Does NOT acquire the write lock itself — callers that need
  // to serialize a drain against a read-modify-rewrite (cleanup) should wrap
  // both in a single withWriteLock() call.
  async function drainToDisk() {
    if (queue.length === 0) return 0;
    const pending = queue;
    queue = [];

    const byPath = new Map();
    for (const entry of pending) {
      const filePath = getFilePath(entry);
      if (!byPath.has(filePath)) byPath.set(filePath, []);
      byPath.get(filePath).push(entry);
    }

    let count = 0;
    let firstError = null;
    for (const [filePath, entries] of byPath) {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
        await fs.appendFile(filePath, lines, 'utf8');
        count += entries.length;
      } catch (error) {
        firstError = firstError || error;
        // Re-buffer only this group's entries so the next flush retries just them.
        queue = entries.concat(queue);
      }
    }
    if (firstError) throw firstError;
    return count;
  }

  async function flush() {
    return withWriteLock(drainToDisk);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      try {
        await flush();
      } catch (error) {
        logger.error(`Failed to flush ${component}`, { component, error });
      }
    }, flushIntervalMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function append(entry) {
    queue.push(entry);
    if (maxQueueSize && queue.length > maxQueueSize) {
      queue.splice(0, queue.length - maxQueueSize);
      if (!overflowed) {
        overflowed = true;
        logger.error(`${component} buffer overflow — dropping oldest entries`, {
          component,
          max: maxQueueSize
        });
      }
    } else {
      overflowed = false;
    }
    scheduleFlush();
  }

  // Periodic safety-net flush: the debounced timer above clears itself before
  // running, so if a flush throws and re-buffers, nothing re-arms it — this
  // interval guarantees re-buffered entries eventually drain even with no
  // further activity.
  const periodicFlush = setInterval(() => {
    if (queue.length > 0) {
      flush().catch(error =>
        logger.error(`${component} periodic flush error`, { component, error })
      );
    }
  }, flushIntervalMs);
  if (typeof periodicFlush.unref === 'function') periodicFlush.unref();

  function stop() {
    clearInterval(periodicFlush);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function queueLength() {
    return queue.length;
  }

  return { append, flush, drainToDisk, withWriteLock, stop, queueLength };
}
