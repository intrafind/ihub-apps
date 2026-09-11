/**
 * Append-only event streams on a filesystem: one JSONL file per stream.
 *
 * Layout under the provider's base directory:
 *
 *   <base>/logs/<...streamSegments>.jsonl        the stream
 *   <base>/logs/<...streamSegments>.blobs/<name> its blobs
 *
 * So `run:abc` is `<base>/logs/run/abc.jsonl` with blobs beside it in
 * `<base>/logs/run/abc.blobs/`. Keeping the blobs in a sibling directory named
 * after the stream file means dropping a stream is two removals in one place,
 * and a retention sweep never has to consult a second index to find the
 * payloads a stream spilled.
 *
 * Writes go through the shared buffered appender (`utils/jsonlAppender.js`) —
 * the same batched-append, periodic-flush and write-lock machinery the run
 * ledger relies on. One appender serves every stream; `getFilePath` routes each
 * queued record to its own file, so a burst across many streams still costs one
 * flush. Reads flush first — unconditionally, because the queue is emptied
 * before a drain writes anything, so a queue that looks empty may still be a
 * drain in flight; an idle read costs no disk write anyway (see
 * {@link FilesystemAppendLog#_barrier}).
 *
 * Sequence numbers are allocated by the caller (see `storage/AppendLog.js`);
 * this log only persists them, and answers `lastSeq()` from disk so a restarted
 * process can continue where the previous one stopped.
 *
 * @module storage/providers/filesystem/FilesystemAppendLog
 */
import { promises as fs, createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import crypto from 'crypto';
import logger from '../../../utils/logger.js';
import { createJsonlAppender } from '../../../utils/jsonlAppender.js';
import { atomicWriteFile } from '../../../utils/atomicWrite.js';
import { AppendLog } from '../../AppendLog.js';
import { StorageError, StorageShutDownError } from '../../errors.js';
import { containedPath, sanitizeBlobName, streamSegments } from './paths.js';

const COMPONENT = 'FilesystemAppendLog';

/** Sub-directory of the provider base directory holding every stream. */
const LOGS_DIR = 'logs';

/** Extension of a stream file. */
const STREAM_EXT = '.jsonl';

/** Extension of the directory holding a stream's blobs, beside its file. */
const BLOBS_EXT = '.blobs';

/** Debounce for buffered writes when the provider config names none. */
const DEFAULT_FLUSH_MS = 2000;

/**
 * Drop-oldest cap on the shared write buffer. Unbounded buffering would turn a
 * stalled disk into an out-of-memory crash; the appender logs an error when it
 * has to drop, so losing ledger records is loud rather than silent.
 */
const MAX_QUEUE = 20000;

const DEFAULT_BLOB_CONTENT_TYPE = 'application/octet-stream';

/**
 * Routing hint carried by every queued record. A symbol key is invisible to
 * `JSON.stringify`, so the appender — which serializes each queued object
 * verbatim — writes the record exactly as the contract specifies while still
 * being able to resolve which file it belongs to at flush time.
 */
const STREAM_FILE = Symbol('streamFile');

/** Truncate an offending value for an error message so logs stay bounded. */
function describe(value) {
  return String(value).slice(0, 64);
}

/**
 * Assert a caller-allocated sequence number.
 *
 * @param {number} seq - Sequence number supplied by the caller
 * @returns {number} `seq`, unchanged, so it can be used inline
 * @throws {StorageError} Code `INVALID_SEQ` when it is not a positive integer
 */
function assertValidSeq(seq) {
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new StorageError(`Append-log seq must be a positive integer, got ${describe(seq)}`, {
      code: 'INVALID_SEQ'
    });
  }
  return seq;
}

/**
 * Serialize a record the way the appender will, up front.
 *
 * A record the appender cannot stringify throws inside the flush, where it is
 * re-buffered and retried forever — one circular payload would block its stream
 * permanently. Rejecting it at `append()` keeps the failure with the caller.
 *
 * @param {Object} record - The record about to be queued
 * @throws {StorageError} Code `INVALID_DATA` when the record is not serializable
 */
function assertSerializable(record) {
  let json;
  try {
    json = JSON.stringify(record);
  } catch (cause) {
    throw new StorageError('Append-log entry must be JSON-serializable', {
      code: 'INVALID_DATA',
      cause
    });
  }
  if (json === undefined) {
    throw new StorageError('Append-log entry must be JSON-serializable', { code: 'INVALID_DATA' });
  }
}

/**
 * Normalize a sweep cut-off into epoch milliseconds.
 *
 * @param {Date|number} olderThan - Cut-off as a Date or epoch milliseconds
 * @returns {number} The cut-off in epoch milliseconds
 * @throws {StorageError} Code `INVALID_ARGUMENT` when it is neither
 */
function toEpochMs(olderThan) {
  const ms = olderThan instanceof Date ? olderThan.getTime() : Number(olderThan);
  if (!Number.isFinite(ms)) {
    throw new StorageError(
      `sweep() needs a Date or epoch-ms olderThan, got ${describe(olderThan)}`,
      {
        code: 'INVALID_ARGUMENT'
      }
    );
  }
  return ms;
}

/**
 * Insert `record` into `out`, which stays sorted by ascending `seq` and never
 * grows past `max`.
 *
 * A bounded insertion rather than a collect-then-sort so that a `read()` with a
 * small `limit` over a long stream still costs `limit` records of memory, the
 * way the previous streaming read did. Scanning backwards from the end keeps
 * the common case — records that were appended in ascending order — at one
 * comparison per record, and inserting *after* equal sequence numbers keeps
 * duplicates in the order they were persisted.
 *
 * @param {Object[]} out - The window built so far, ascending by `seq`
 * @param {Object} record - Record to place in it
 * @param {number} max - Largest the window may grow (may be `Infinity`)
 * @returns {void}
 */
function insertBySeq(out, record, max) {
  if (out.length >= max && record.seq >= out[out.length - 1].seq) return;
  let index = out.length;
  while (index > 0 && out[index - 1].seq > record.seq) index -= 1;
  out.splice(index, 0, record);
  if (out.length > max) out.pop();
}

/** Whether a path exists; anything but a missing entry is reported as present. */
async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Coerce accepted blob input into a Buffer without copying when possible. */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  throw new StorageError('Blob content must be a Buffer, string or Uint8Array', {
    code: 'INVALID_DATA'
  });
}

/**
 * Filesystem-backed {@link AppendLog}.
 *
 * @augments AppendLog
 */
export class FilesystemAppendLog extends AppendLog {
  /**
   * @param {Object} options
   * @param {string} options.baseDir - Absolute provider base directory; streams live
   *   under `<baseDir>/logs`, beside the document namespaces
   * @param {number} [options.flushIntervalMs=2000] - Debounce and safety-net interval
   *   for buffered writes
   */
  constructor({ baseDir, flushIntervalMs } = {}) {
    super();
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw new StorageError('FilesystemAppendLog requires a baseDir', { code: 'INVALID_CONFIG' });
    }
    this._baseDir = path.resolve(baseDir);
    this._logsDir = path.join(this._baseDir, LOGS_DIR);
    this._appender = createJsonlAppender({
      // Every record is queued with its resolved target file attached, so the
      // path is validated at append() time rather than inside a flush.
      getFilePath: record => record[STREAM_FILE],
      flushIntervalMs: Number(flushIntervalMs) || DEFAULT_FLUSH_MS,
      maxQueueSize: MAX_QUEUE,
      component: COMPONENT
    });
    /** Set by `stop()`; a stopped log refuses writes rather than buffering them. */
    this._stopped = false;
  }

  /**
   * Absolute directory holding every stream file.
   * @returns {string}
   */
  get logsDir() {
    return this._logsDir;
  }

  /**
   * Absolute path of a stream's JSONL file.
   *
   * @param {string} stream - Stream identifier, e.g. `run:<runId>`
   * @returns {string} The resolved path, guaranteed to stay under `logsDir`
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   */
  streamFilePath(stream) {
    const segments = streamSegments(stream);
    const last = segments.length - 1;
    return containedPath(
      this._logsDir,
      ...segments.slice(0, last),
      `${segments[last]}${STREAM_EXT}`
    );
  }

  /**
   * Append one record to a stream.
   *
   * The persisted record is `{ ...entry, seq }`: the caller's sequence number
   * is applied last, so a `seq` already inside `entry` is overwritten.
   *
   * @param {string} stream - Stream identifier
   * @param {Object} entry - Record body; must be JSON-serializable
   * @param {number} seq - Caller-allocated positive integer sequence number
   * @returns {Promise<{stream: string, seq: number}>} The accepted coordinates
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   * @throws {StorageError} Code `INVALID_SEQ` or `INVALID_DATA`
   */
  async append(stream, entry, seq) {
    this._assertRunning(`append to ${stream}`);
    const file = this.streamFilePath(stream);
    this._appender.append(this._record(entry, seq, file));
    return { stream, seq };
  }

  /**
   * Append several records to one stream in the order given.
   *
   * Every item is validated before any of them is queued, so a bad sequence
   * number in the middle of a batch cannot leave half of it written.
   *
   * @param {string} stream - Stream identifier
   * @param {Array<{entry: Object, seq: number}>} items - Records to append
   * @returns {Promise<{stream: string, count: number, lastSeq: number}>} How many
   *   records were accepted and the highest sequence number among them
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   * @throws {StorageError} Code `INVALID_SEQ` or `INVALID_DATA`
   */
  async appendBatch(stream, items) {
    this._assertRunning(`appendBatch to ${stream}`);
    const file = this.streamFilePath(stream);
    const list = Array.isArray(items) ? items : [];
    const records = list.map(item => this._record(item?.entry, item?.seq, file));
    let lastSeq = 0;
    for (const record of records) {
      this._appender.append(record);
      if (record.seq > lastSeq) lastSeq = record.seq;
    }
    return { stream, count: records.length, lastSeq };
  }

  /**
   * Read a stream forward from `afterSeq`, in ascending sequence order.
   *
   * The order is the caller's sequence numbers, not the order the records
   * reached the file: appends arrive from several call sites and a flush groups
   * them per file, so the two can differ, and `limit` has to select the *lowest*
   * sequence numbers or a caller paging with `afterSeq` would skip records. That
   * also means the whole file is scanned even for a small `limit` — a record
   * with a lower sequence number can sit anywhere in it — while the returned
   * window stays capped at `limit`.
   *
   * @param {string} stream - Stream identifier
   * @param {Object} [opts]
   * @param {number} [opts.afterSeq=0] - Return only records with a greater `seq`
   * @param {number} [opts.limit=Infinity] - Maximum number of records
   * @returns {Promise<Array<Object>>} The records, by ascending `seq`
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   */
  async read(stream, { afterSeq = 0, limit = Infinity } = {}) {
    const file = this.streamFilePath(stream);
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
    if (max === 0) return [];
    const after = Number.isFinite(afterSeq) ? afterSeq : 0;
    await this._barrier();
    const out = [];
    await this._eachRecord(file, record => {
      if (record.seq > after) insertBySeq(out, record, max);
      return true;
    });
    return out;
  }

  /**
   * Highest sequence number persisted for a stream, or 0 when it holds nothing.
   *
   * The whole file is scanned for the maximum rather than trusting its last
   * line: records reach the buffer from several call sites and a flush groups
   * them per file, so the highest sequence number is not necessarily the last
   * one written. Reading it from disk (never from memory) is what makes the
   * value survive a restart.
   *
   * @param {string} stream - Stream identifier
   * @returns {Promise<number>} The highest persisted sequence number, or 0
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   */
  async lastSeq(stream) {
    const file = this.streamFilePath(stream);
    await this._barrier();
    let highest = 0;
    await this._eachRecord(file, record => {
      if (Number.isFinite(record.seq) && record.seq > highest) highest = record.seq;
      return true;
    });
    return highest;
  }

  /**
   * Delete a stream and every blob stored beside it.
   *
   * Runs under the appender's write lock and drains the buffer first, so a
   * flush that was already in flight can neither race the removal nor recreate
   * the file afterwards.
   *
   * @param {string} stream - Stream identifier
   * @returns {Promise<boolean>} True when a stream file or blob was removed
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   */
  async deleteStream(stream) {
    const file = this.streamFilePath(stream);
    const blobDir = this._blobDirPath(stream);
    return this._appender.withWriteLock(async () => {
      await this._drain();
      let removed = false;
      try {
        await fs.unlink(file);
        removed = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if ((await this._removeBlobDir(blobDir)) > 0) removed = true;
      return removed;
    });
  }

  /**
   * Retention sweep: remove every stream last modified before `olderThan`,
   * together with its blobs.
   *
   * Blob directories are swept as candidates in their own right, not only as a
   * side effect of finding the stream file beside them. A blob outlives its
   * stream file whenever `putBlob` ran for a stream whose first records never
   * reached disk, or whenever a removal got half-way, and blobs are the large
   * payloads — a retention sweep that can never see them is a disk that only
   * grows.
   *
   * @param {Object} opts
   * @param {Date|number} opts.olderThan - Cut-off as a Date or epoch milliseconds
   * @returns {Promise<{streams: number, blobs: number}>} How many streams and blobs went
   * @throws {StorageError} Code `INVALID_ARGUMENT` when `olderThan` is unusable
   */
  async sweep({ olderThan } = {}) {
    const cutoff = toEpochMs(olderThan);
    let streams = 0;
    let blobs = 0;
    await this._appender.withWriteLock(async () => {
      await this._drain();
      const found = await this._collectSweepTargets(this._logsDir);
      for (const file of found.streams) {
        try {
          const stat = await fs.stat(file);
          if (stat.mtimeMs >= cutoff) continue;
          // Blobs go first: a stream file left behind by a failed removal is
          // recoverable data, an orphaned blob directory is only garbage.
          blobs += await this._removeBlobDir(file.slice(0, -STREAM_EXT.length) + BLOBS_EXT);
          await fs.unlink(file);
          streams += 1;
        } catch (err) {
          logger.warn('Failed to sweep append-log stream', {
            component: COMPONENT,
            file: path.basename(file),
            error: err.message
          });
        }
      }
      for (const dir of found.blobDirs) {
        try {
          // A blob directory whose stream file is still on disk belongs to a
          // stream that survived the cut-off, and the stream — not the
          // directory's own mtime — decides its fate. One whose stream was
          // swept above went with it and is already gone (ENOENT, below).
          const stream = `${dir.slice(0, -BLOBS_EXT.length)}${STREAM_EXT}`;
          if (await pathExists(stream)) continue;
          const stat = await fs.stat(dir);
          if (stat.mtimeMs >= cutoff) continue;
          blobs += await this._removeBlobDir(dir);
        } catch (err) {
          if (err.code === 'ENOENT') continue; // swept with its stream above
          logger.warn('Failed to sweep orphaned append-log blobs', {
            component: COMPONENT,
            dir: path.basename(dir),
            error: err.message
          });
        }
      }
    });
    return { streams, blobs };
  }

  /**
   * Store a blob beside a stream.
   *
   * Written through `atomicWriteFile` (temp file + rename) so a concurrent
   * reader never observes a half-written payload. Buffers pass through
   * unchanged — `fs.writeFile` ignores the encoding argument for binary data.
   *
   * @param {string} stream - Stream identifier
   * @param {string} name - Blob name; sanitized into one safe path segment
   * @param {Buffer|string|Uint8Array} bytes - Content to store
   * @param {Object} [opts]
   * @param {string} [opts.contentType='application/octet-stream'] - MIME type
   * @returns {Promise<{stream: string, name: string, bytes: number, sha256: string,
   *   contentType: string}>} Reference to the stored blob
   * @throws {InvalidKeyError} When `stream` or `name` is not usable
   * @throws {StorageError} Code `INVALID_DATA` for unsupported content
   */
  async putBlob(stream, name, bytes, { contentType = DEFAULT_BLOB_CONTENT_TYPE } = {}) {
    const safeName = sanitizeBlobName(name);
    const dir = this._blobDirPath(stream);
    const file = containedPath(dir, safeName);
    const buffer = toBuffer(bytes);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(file, buffer, 'binary');
    return {
      stream,
      name: safeName,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      contentType
    };
  }

  /**
   * Read a blob stored beside a stream.
   *
   * @param {string} stream - Stream identifier
   * @param {string} name - Blob name as passed to {@link FilesystemAppendLog#putBlob}
   * @returns {Promise<Buffer|null>} The content, or null when it does not exist
   * @throws {InvalidKeyError} When `stream` or `name` is not usable
   */
  async getBlob(stream, name) {
    const file = containedPath(this._blobDirPath(stream), sanitizeBlobName(name));
    try {
      return await fs.readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Drain every buffered write to disk.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this._appender.flush();
  }

  /**
   * Clear the appender's debounce and safety-net timers.
   *
   * Both are unref'd, so they never hold the process open by themselves; this
   * exists so a test run that creates many logs leaves no timers behind at all.
   * Buffered records are not written — call {@link FilesystemAppendLog#close}
   * to flush and stop in one step.
   *
   * @returns {void}
   */
  stop() {
    this._stopped = true;
    this._appender.stop();
  }

  /**
   * Refuse a write once the timers are gone.
   *
   * This log buffers: without the guard, a record appended after the final
   * flush is queued into memory that nothing will ever drain, and the caller
   * is told it was accepted. A run ledger then ends one record short of
   * whatever the process was shutting down over, with nothing anywhere saying
   * so. An error the caller can log is strictly better than a lie.
   *
   * @param {string} what - The attempted operation, for the message.
   * @throws {StorageShutDownError} When the log has been stopped.
   * @private
   */
  _assertRunning(what) {
    if (this._stopped) {
      throw new StorageShutDownError(`Storage has shut down; cannot ${what}`);
    }
  }

  /**
   * Flush everything buffered, then stop the timers.
   *
   * The timers are cleared even when the final flush fails, so a failing disk
   * cannot keep the log alive after shutdown.
   *
   * @returns {Promise<void>}
   */
  async close() {
    try {
      await this.flush();
    } finally {
      this._appender.stop();
    }
  }

  /**
   * Build the record that will be persisted for `entry`.
   *
   * @param {Object} entry - Record body
   * @param {number} seq - Caller-allocated sequence number
   * @param {string} file - Resolved target file, attached as the routing hint
   * @returns {Object} The record, ready to be queued
   * @private
   */
  _record(entry, seq, file) {
    assertValidSeq(seq);
    const record = { ...entry, seq };
    assertSerializable(record);
    record[STREAM_FILE] = file;
    return record;
  }

  /**
   * Absolute path of the directory holding a stream's blobs.
   *
   * @param {string} stream - Stream identifier
   * @returns {string} `<...stream segments>.blobs`, beside the stream file
   * @private
   */
  _blobDirPath(stream) {
    const segments = streamSegments(stream);
    const last = segments.length - 1;
    return containedPath(
      this._logsDir,
      ...segments.slice(0, last),
      `${segments[last]}${BLOBS_EXT}`
    );
  }

  /**
   * Wait until everything appended so far is on disk.
   *
   * Deliberately unconditional. `drainToDisk()` empties the queue *before* it
   * writes anything, so for the whole duration of a drain — one started by the
   * debounce timer, by the periodic safety net, or by another caller's
   * `flush()` — `queueLength()` reports 0 while those records exist only in the
   * drain's local array. Skipping the flush on that reading would let a read
   * stream a file that does not hold the records yet, and would let `lastSeq()`
   * answer 0 for a stream whose numbers are already allocated.
   *
   * Guarding on `queueLength() > 0` also buys nothing: `flush()` takes the
   * appender's write lock (which is what makes the caller wait out an in-flight
   * drain) and `drainToDisk()` returns immediately on an empty queue, so a read
   * of an idle log still touches no file.
   *
   * The buffer is shared by every stream, so this drains all of them — a
   * superset of the records the caller's stream needs.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _barrier() {
    await this._appender.flush();
  }

  /**
   * Drain the buffer from inside the write lock (where `flush()` would
   * deadlock). A failure is logged rather than thrown: the caller is removing
   * files, and records that could not be written are re-buffered by the
   * appender for the next flush.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _drain() {
    try {
      await this._appender.drainToDisk();
    } catch (error) {
      logger.warn('Failed to drain append-log buffer', { component: COMPONENT, error });
    }
  }

  /**
   * Stream a JSONL file record by record.
   *
   * Line-at-a-time so memory stays flat on a long stream. Malformed lines are
   * skipped rather than thrown: a torn tail from a crashed write must not make
   * the records before it unreadable. A stream that does not exist reads as
   * empty.
   *
   * @param {string} file - Absolute path of the stream file
   * @param {(record: Object) => boolean} onRecord - Called per record; return
   *   false to stop reading
   * @returns {Promise<void>}
   * @private
   */
  async _eachRecord(file, onRecord) {
    const input = createReadStream(file, 'utf8');
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object') continue;
        if (onRecord(record) === false) break;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    } finally {
      rl.close();
      input.destroy();
    }
  }

  /**
   * Remove a blob directory and report how many blobs it held.
   *
   * @param {string} dir - Absolute path of the `.blobs` directory
   * @returns {Promise<number>} Number of blobs removed (0 when absent)
   * @private
   */
  async _removeBlobDir(dir) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    await fs.rm(dir, { recursive: true, force: true });
    return names.length;
  }

  /**
   * Collect everything a sweep may remove under `dir`, recursing into the kind
   * directories.
   *
   * @param {string} dir - Directory to walk
   * @param {{streams: string[], blobDirs: string[]}} [out] - Accumulator,
   *   returned for convenience
   * @returns {Promise<{streams: string[], blobDirs: string[]}>} Absolute paths
   *   of the stream files and blob directories found
   * @private
   */
  async _collectSweepTargets(dir, out = { streams: [], blobDirs: [] }) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return out;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A `.blobs` directory holds payloads, not streams — and a blob may
        // itself be named `*.jsonl`, so it is recorded as its own candidate
        // rather than walked as a directory of streams.
        if (entry.name.endsWith(BLOBS_EXT)) {
          out.blobDirs.push(abs);
          continue;
        }
        await this._collectSweepTargets(abs, out);
      } else if (entry.isFile() && entry.name.endsWith(STREAM_EXT)) {
        out.streams.push(abs);
      }
    }
    return out;
  }
}

export default FilesystemAppendLog;
