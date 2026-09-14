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

  /**
   * Files this process has already checked for a torn tail.
   *
   * A file we have appended to ends in a newline by construction, so the check
   * is worth making once per file per process. Bounded, because a run ledger
   * opens one file per run: past the cap the oldest entries are forgotten and
   * re-checked, which costs a `stat` and nothing else.
   */
  const terminated = new Set();
  const MAX_TERMINATOR_MEMO = 10_000;

  /**
   * Give a file a final newline if it is missing one.
   *
   * `drainToDisk` writes `entries.join('\n') + '\n'`, which assumes whatever
   * is already in the file ends in a newline. A process killed mid-`appendFile`
   * breaks that assumption: the file ends in a partial line with no terminator,
   * and the next batch is concatenated onto it. The torn record is expected to
   * be lost — `_eachRecord` skips a line it cannot parse — but the *first
   * record written after the restart* is glued to it and dies with it, silently
   * and completely, even though it was written cleanly. For a run ledger that
   * is the event the crash was about.
   *
   * Here rather than in one caller: all four consumers — the run ledger,
   * feedback, usage events and the audit log — write through this function and
   * inherit the same assumption. One `stat`, and a one-byte read only when the
   * file is not empty, per file per process.
   *
   * @param {string} filePath - File about to be appended to.
   * @returns {Promise<void>}
   */
  async function ensureTerminated(filePath) {
    if (terminated.has(filePath)) return;
    // Marked before the check, so two overlapping drains cannot both append a
    // newline. A failed check is not worth retrying every flush either.
    terminated.add(filePath);
    while (terminated.size > MAX_TERMINATOR_MEMO) {
      terminated.delete(terminated.values().next().value);
    }
    let handle;
    try {
      const { size } = await fs.stat(filePath);
      if (size === 0) return;
      handle = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      if (buffer[0] !== 0x0a) await fs.appendFile(filePath, '\n', 'utf8');
    } catch (error) {
      // No file yet is the ordinary case; anything else leaves the append to
      // fail on its own terms rather than being masked here.
      if (error.code !== 'ENOENT') {
        logger.warn('Could not check the last byte of a JSONL file', {
          component,
          filePath,
          error: error.message
        });
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

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
        await ensureTerminated(filePath);
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
