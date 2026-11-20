// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * Encryption at rest (#2316). With a sealing mode (see `./atRestContext.js`)
 * records are sealed **when a batch is flushed**, not when they are appended:
 * the queue keeps plaintext records, so `append()` still queues before its
 * first `await`, which is what the run ledger's ordering relies on. Each
 * flushed batch of a stream is one key line followed by its sealed records
 * (`crypto/logSeal.js`), written in one `appendFile`. A line is a sealed
 * record when it has the own property `$enc`, a key line when it has `$key`,
 * and a plaintext record otherwise; `append()` refuses a caller's record with
 * either property, in every mode. One file may hold all three kinds: it is
 * read in the modes `off` and `converting`, while in the mode `enforced` a
 * plaintext record is an error (`CORRUPT_LOG`). Spill blobs are sealed with
 * the blob envelope and recognised by its magic.
 *
 * @module storage/providers/filesystem/FilesystemAppendLog
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from '../../../utils/logger.js';
import { createJsonlAppender } from '../../../utils/jsonlAppender.js';
import { atomicWriteFile, writeFully } from '../../../utils/atomicWrite.js';
import { AppendLog } from '../../AppendLog.js';
import {
  CorruptBlobError,
  CorruptLogError,
  KeyUnavailableError,
  StorageError,
  StorageShutDownError
} from '../../errors.js';
import {
  hasReservedProperty,
  isKeyLine,
  isLogBlobEnvelope,
  isSealedLine,
  isWellFormedSealedLine,
  newBatchKey,
  openBatchKey,
  openLogBlob,
  openRecord,
  sealLogBlob,
  sealRecord
} from '../../../crypto/logSeal.js';
import { AtRestContext } from './atRestContext.js';
import { containedPath, sanitizeBlobName, streamKindSegment, streamSegments } from './paths.js';

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

/**
 * The canonical id of the stream a queued record belongs to, carried the same
 * way: a sealed record is bound to it.
 */
const STREAM_NAME = Symbol('streamName');

/** Suffix of the scratch file a stream is rewritten into by the conversion. */
const SEALING_EXT = '.sealing';

/**
 * A scratch file of {@link FilesystemAppendLog#sealStreamFile}:
 * `<stream>.jsonl.<16 hex>.sealing`, and `<stream>.jsonl.sealing` as an
 * earlier build named it. The random part keeps two processes from ever
 * writing into one scratch file.
 */
const SCRATCH_NAME = /\.jsonl(?:\.[0-9a-f]{16})?\.sealing$/;

/** Prefix `atomicWrite` gives its scratch files. */
const TEMP_PREFIX = '.tmp_';

/** Bytes of rewritten lines held before they are written out. */
const REWRITE_CHUNK_BYTES = 1024 * 1024;

/** Spill blobs sealed at once by the conversion. */
const SPILL_CONCURRENCY = 8;

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
  if (out.length >= max && record.seq >= out.at(-1).seq) return;
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
   * @param {AtRestContext} [options.atRest] - Encryption mode and key access,
   *   shared with the provider's document store; omitted, records are plaintext
   */
  constructor({ baseDir, flushIntervalMs, atRest } = {}) {
    super();
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw new StorageError('FilesystemAppendLog requires a baseDir', { code: 'INVALID_CONFIG' });
    }
    this._baseDir = path.resolve(baseDir);
    this._logsDir = path.join(this._baseDir, LOGS_DIR);
    this._atRest = atRest || new AtRestContext();
    this._appender = createJsonlAppender({
      // Sealing happens here, when a batch is written, never in `append()`.
      serializeBatch: (_filePath, entries) => this._serializeBatch(entries),
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
    this._appender.append(this._record(entry, seq, file, this._canonical(stream)));
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
    const canonical = this._canonical(stream);
    const records = list.map(item => this._record(item?.entry, item?.seq, file, canonical));
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
    // The window is built from the lines as stored: `seq` is readable on a
    // sealed line, so only the records that are returned get opened.
    const out = [];
    const keyLines = await this._scanStream(stream, file, line => {
      if (line.seq > after) insertBySeq(out, line, max);
    });
    return this._openLines(stream, out, keyLines);
  }

  /**
   * Highest sequence number persisted for a stream, or 0 when it holds nothing.
   *
   * @param {string} stream - Stream identifier
   * @returns {Promise<number>} The highest persisted sequence number, or 0
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   */
  async lastSeq(stream) {
    return (await this.lastRecord(stream))?.seq || 0;
  }

  /**
   * The record carrying the highest persisted sequence number, or null.
   *
   * The whole file is scanned rather than its last line trusted: records reach
   * the buffer from several call sites and a flush groups them per file, so the
   * highest sequence number is not necessarily the last one written. Reading it
   * from disk (never from memory) is what makes the value survive a restart.
   *
   * That scan is also why this exists as its own method. It already holds the
   * record it found the maximum in, so handing it back costs nothing, while a
   * caller reconstructing it through `read({afterSeq: seq - 1, limit: 1})` pays
   * for a second full pass — `read` cannot stop early either (see its comment).
   *
   * @param {string} stream - Stream identifier
   * @returns {Promise<Object|null>} The record, or null when the stream is empty
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   */
  async lastRecord(stream) {
    const file = this.streamFilePath(stream);
    await this._barrier();
    let last = null;
    const keyLines = await this._scanStream(stream, file, line => {
      if (Number.isFinite(line.seq) && (!last || line.seq > last.seq)) last = line;
    });
    if (!last) return null;
    return (await this._openLines(stream, [last], keyLines))[0];
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
  async sweep({ olderThan, kind } = {}) {
    const cutoff = toEpochMs(olderThan);
    let streams = 0;
    let blobs = 0;
    // A stream name's first segment is its directory, so scoping is a matter
    // of where the walk starts.
    const root =
      kind === undefined || kind === null
        ? this._logsDir
        : containedPath(this._logsDir, streamKindSegment(kind));

    // The lock covers the drain and nothing else. Held across the whole walk —
    // a readdir per directory and a stat per file, which at 90-day retention
    // is on the order of 10^5 files — it queued `read()` and `lastSeq()`
    // behind it through the shared barrier, and the retention scheduler fires
    // at boot. The drain is the only part that needs exclusion: after it, the
    // buffer is empty and a concurrent append creates or touches a file, which
    // the cutoff check below then spares on its own.
    await this._appender.withWriteLock(() => this._drain());

    const found = await this._collectSweepTargets(root);
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
    // `bytes` and `sha256` below describe the payload in every mode: the
    // reference is copied into the ledger and hashed there.
    // A payload that itself looks like an envelope is sealed even with
    // encryption off, so "starts with the envelope magic" always means
    // "is an envelope" on read.
    const stored =
      this._atRest.writesSealed || isLogBlobEnvelope(buffer)
        ? await this._sealBlob(stream, safeName, buffer)
        : buffer;
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(file, stored, 'binary');
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
    const safeName = sanitizeBlobName(name);
    const file = containedPath(this._blobDirPath(stream), safeName);
    let stored;
    try {
      stored = await fs.readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    // Recognised by the envelope header alone, never by trying to decrypt.
    if (!isLogBlobEnvelope(stored)) {
      if (this._atRest.rejectsPlaintext) {
        logger.error('A spill blob is not encrypted although encryption at rest is enforced', {
          component: COMPONENT,
          code: 'CORRUPT_BLOB',
          stream,
          name: safeName
        });
        throw new CorruptBlobError(
          `Blob ${safeName} of stream ${stream} is stored in plaintext although encryption at rest is enforced`
        );
      }
      return stored;
    }
    const what = `blob ${safeName} of stream ${stream}`;
    const keyProvider = await this._atRest.keyProvider();
    try {
      return await openLogBlob({
        keyProvider,
        tenant: this._atRest.tenant,
        stream: this._canonical(stream),
        name: safeName,
        stored
      });
    } catch (error) {
      const failure =
        this._atRest.keyFailure(error, what) ||
        new CorruptBlobError(`The ${what} does not open`, { cause: error });
      logger.error('A spill blob could not be opened', {
        component: COMPONENT,
        code: failure.code,
        stream,
        name: safeName,
        reason: error.code || error.reason
      });
      throw failure;
    }
  }

  /**
   * Seal the payload of one spill blob.
   *
   * @param {string} stream - Stream identifier.
   * @param {string} safeName - Blob name as stored.
   * @param {Buffer} plain - The payload.
   * @returns {Promise<Buffer>} The envelope.
   * @throws {KeyUnavailableError} When the data key cannot be wrapped; nothing
   *   is written then.
   * @private
   */
  async _sealBlob(stream, safeName, plain) {
    const keyProvider = await this._atRest.keyProvider();
    try {
      return await sealLogBlob({
        keyProvider,
        tenant: this._atRest.tenant,
        stream: this._canonical(stream),
        name: safeName,
        plain
      });
    } catch (error) {
      throw (
        this._atRest.keyFailure(error, `blob ${safeName} of stream ${stream}`) ||
        new StorageError(`Blob ${safeName} of stream ${stream} could not be sealed`, {
          code: 'IO_ERROR',
          cause: error
        })
      );
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
   * @param {string} canonical - Canonical stream id, attached for sealing
   * @returns {Object} The record, ready to be queued
   * @throws {StorageError} Code `INVALID_DATA` when the entry has a property
   *   the line format reserves (`$enc`, `$key`), in every mode
   * @private
   */
  _record(entry, seq, file, canonical) {
    assertValidSeq(seq);
    if (hasReservedProperty(entry)) {
      throw new StorageError('Append-log entry must not have a "$enc" or "$key" property', {
        code: 'INVALID_DATA'
      });
    }
    const record = { ...entry, seq };
    assertSerializable(record);
    record[STREAM_FILE] = file;
    record[STREAM_NAME] = canonical;
    return record;
  }

  /**
   * The canonical id of a stream: its path segments joined with `:`. Two
   * spellings of one file (`abc` and `_:abc`) get one id, which is what a
   * sealed record is bound to and what the conversion derives from a path.
   *
   * @param {string} stream - Stream identifier
   * @returns {string}
   * @throws {InvalidKeyError} When `stream` is not a usable identifier
   * @private
   */
  _canonical(stream) {
    return streamSegments(stream).join(':');
  }

  /**
   * The text one flush appends to one stream file: plaintext lines, or one
   * key line and the sealed records.
   *
   * @param {Object[]} entries - The queued records of one file, in order.
   * @returns {Promise<string>} Lines, final newline included.
   * @throws {KeyUnavailableError} When the batch key cannot be wrapped. The
   *   appender then keeps the records queued, in plaintext, in memory only.
   * @private
   */
  async _serializeBatch(entries) {
    if (!this._atRest.writesSealed) {
      return entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    }
    const stream = entries[0][STREAM_NAME];
    const tenant = this._atRest.tenant;
    const keyProvider = await this._atRest.keyProvider();
    let batch;
    try {
      batch = await newBatchKey({ keyProvider, tenant, stream });
    } catch (error) {
      throw (
        this._atRest.keyFailure(error, `stream ${stream}`) ||
        new StorageError(`Records of stream ${stream} could not be sealed`, {
          code: 'IO_ERROR',
          cause: error
        })
      );
    }
    try {
      const lines = [JSON.stringify(batch.line)];
      for (const entry of entries) {
        const line = sealRecord({
          dataKey: batch.dataKey,
          tenant,
          stream,
          id: batch.id,
          seq: entry.seq,
          json: JSON.stringify(entry)
        });
        lines.push(JSON.stringify(line));
      }
      return lines.join('\n') + '\n';
    } finally {
      batch.dataKey.fill(0);
    }
  }

  /**
   * Walk a stream file and hand every record line, sealed or plaintext, to
   * `onLine`; key lines are collected instead.
   *
   * @param {string} stream - Stream identifier, for messages
   * @param {string} file - Absolute path of the stream file
   * @param {(line: Object) => void} onLine - Called per record line as stored
   * @returns {Promise<Map<string, Object>>} The key lines of the file by id
   * @throws {CorruptLogError} For a sealed line that is not in its format,
   *   and for a plaintext record in the mode `enforced`
   * @private
   */
  async _scanStream(stream, file, onLine) {
    const keyLines = new Map();
    await this._eachRecord(file, line => {
      if (isKeyLine(line)) {
        if (typeof line.id === 'string') keyLines.set(line.id, line);
        return true;
      }
      if (isSealedLine(line)) {
        if (!isWellFormedSealedLine(line)) {
          throw this._corruptLog(stream, 'holds a sealed record that is not readable');
        }
      } else if (this._atRest.rejectsPlaintext) {
        throw this._corruptLog(
          stream,
          'holds a plaintext record although encryption at rest is enforced'
        );
      }
      onLine(line);
      return true;
    });
    return keyLines;
  }

  /**
   * Turn selected lines into records: a plaintext line is the record, a
   * sealed line is opened with the key line it names. A data key is unwrapped
   * once per call and zeroed before the call returns.
   *
   * @param {string} stream - Stream identifier
   * @param {Object[]} lines - Lines as stored, in the order to return
   * @param {Map<string, Object>} keyLines - Key lines of the file by id
   * @returns {Promise<Object[]>} The records
   * @throws {CorruptLogError} When a record does not open or names a key line
   *   the file does not hold; never skipped
   * @throws {KeyUnavailableError} When the master key it needs is not here
   * @private
   */
  async _openLines(stream, lines, keyLines) {
    if (!lines.some(isSealedLine)) return lines;
    const tenant = this._atRest.tenant;
    const canonical = this._canonical(stream);
    const keyProvider = await this._atRest.keyProvider();
    const dataKeys = new Map();
    try {
      const records = [];
      for (const line of lines) {
        if (!isSealedLine(line)) {
          records.push(line);
          continue;
        }
        try {
          let dataKey = dataKeys.get(line.k);
          if (!dataKey) {
            const keyLine = keyLines.get(line.k);
            if (!keyLine) {
              throw this._corruptLog(
                stream,
                `names a key line that is not in the file (seq ${line.seq})`
              );
            }
            dataKey = await openBatchKey({ keyProvider, tenant, stream: canonical, line: keyLine });
            dataKeys.set(line.k, dataKey);
          }
          records.push(openRecord({ dataKey, tenant, stream: canonical, line }));
        } catch (error) {
          if (error instanceof CorruptLogError) throw error;
          throw (
            this._atRest.keyFailure(error, `stream ${stream}`) ||
            this._corruptLog(stream, `holds a record that does not open (seq ${line.seq})`, error)
          );
        }
      }
      return records;
    } finally {
      for (const dataKey of dataKeys.values()) dataKey.fill(0);
    }
  }

  /**
   * Log and build the error for a stream that cannot be read as stored.
   *
   * @param {string} stream - Stream identifier
   * @param {string} what - What is wrong, completing "Stream <id> …"
   * @param {unknown} [cause]
   * @returns {CorruptLogError}
   * @private
   */
  _corruptLog(stream, what, cause) {
    logger.error('An append-log stream cannot be read as stored', {
      component: COMPONENT,
      code: 'CORRUPT_LOG',
      stream,
      reason: what,
      ...(cause ? { detail: cause.code || cause.reason } : {})
    });
    return new CorruptLogError(`Stream ${stream} ${what}`, cause ? { cause } : {});
  }

  /**
   * Every stream file and every blob directory on disk, for the one-time
   * conversion (`storage/atRest/convert.js`).
   *
   * @param {Object} [options]
   * @param {boolean} [options.removeScratch=false] - Remove the scratch files
   *   an interrupted conversion left behind. Only the process that holds the
   *   conversion lease may ask for it (`storage/atRest/prepare.js`): a scratch
   *   file can also belong to a conversion that is running in another process.
   * @returns {Promise<{streams: string[], blobDirs: string[]}>} Absolute paths
   */
  async atRestTargets({ removeScratch = false } = {}) {
    const found = { streams: [], blobDirs: [] };
    const walk = async dir => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith(BLOBS_EXT)) found.blobDirs.push(abs);
          else await walk(abs);
        } else if (entry.isFile() && SCRATCH_NAME.test(entry.name)) {
          if (removeScratch) await fs.rm(abs, { force: true });
        } else if (entry.isFile() && entry.name.endsWith(STREAM_EXT)) {
          found.streams.push(abs);
        }
      }
    };
    await walk(this._logsDir);
    found.streams.sort();
    found.blobDirs.sort();
    return found;
  }

  /**
   * The canonical stream id of a stream file or blob directory on disk.
   *
   * @param {string} target - Absolute path of a `.jsonl` file or `.blobs` directory
   * @returns {string}
   * @private
   */
  _canonicalOfPath(target) {
    const ext = target.endsWith(BLOBS_EXT) ? BLOBS_EXT : STREAM_EXT;
    const relative = path.relative(this._logsDir, target).slice(0, -ext.length);
    return relative.split(path.sep).join(':');
  }

  /**
   * Count the lines of a stream file by kind.
   *
   * Without `verify` nothing is opened. With it the file is checked the way a
   * read would find it: every key line must unwrap with the master key, every
   * sealed record must name a key line of this file, and the first record
   * under each key line must open. That is what tells a stream that two
   * writers mixed up from one that merely has the right kinds of lines.
   *
   * @param {string} file - Absolute path from {@link FilesystemAppendLog#atRestTargets}
   * @param {Object} [options]
   * @param {boolean} [options.verify=false] - Open records as described above.
   * @returns {Promise<{plain: number, sealed: number, torn: number, bytes: number, damaged: number}>}
   *   `plain` plaintext records, `sealed` sealed records, `torn` lines that
   *   are no record at all (an unfinished write), `bytes` the file size,
   *   `damaged` sealed records and key lines that do not open (always 0
   *   without `verify`)
   * @throws {KeyUnavailableError} With `verify`, when the master key a key
   *   line names is not available
   */
  async inspectStreamFile(file, { verify = false } = {}) {
    const counts = { plain: 0, sealed: 0, torn: 0, bytes: 0, damaged: 0 };
    try {
      counts.bytes = (await fs.stat(file)).size;
    } catch (err) {
      if (err.code === 'ENOENT') return counts;
      throw err;
    }
    const stream = verify ? this._canonicalOfPath(file) : null;
    const tenant = this._atRest.tenant;
    /** Key line id -> whether a record under it has been opened. */
    const keyLines = new Map();
    const dataKeys = new Map();
    try {
      for await (const { line } of this._rawLines(file)) {
        if (!line) counts.torn += 1;
        else if (isKeyLine(line)) {
          if (!verify) continue;
          try {
            const keyProvider = await this._atRest.keyProvider();
            dataKeys.set(line.id, await openBatchKey({ keyProvider, tenant, stream, line }));
            keyLines.set(line.id, false);
          } catch (error) {
            const failure = this._atRest.keyFailure(error, `stream ${stream}`);
            if (failure instanceof KeyUnavailableError) throw failure;
            counts.damaged += 1;
          }
        } else if (isSealedLine(line)) {
          counts.sealed += 1;
          if (!verify) continue;
          if (!keyLines.has(line.k)) {
            counts.damaged += 1;
          } else if (!keyLines.get(line.k)) {
            keyLines.set(line.k, true);
            try {
              openRecord({ dataKey: dataKeys.get(line.k), tenant, stream, line });
            } catch {
              counts.damaged += 1;
            }
          }
        } else if (Number.isInteger(line.seq) && line.seq > 0) counts.plain += 1;
        else counts.torn += 1;
      }
    } finally {
      for (const dataKey of dataKeys.values()) dataKey.fill(0);
    }
    return counts;
  }

  /**
   * Seal the plaintext records of one stream file in place, for the
   * conversion: key lines and sealed records are copied as they are, the
   * plaintext records are sealed under one new key line, and lines that are
   * no record (a torn write, which no read ever returned) are dropped, so no
   * plaintext fragment stays behind. Written to a scratch file, synced and
   * renamed over the stream; the modification time is kept, because the
   * retention sweep judges a stream by it.
   *
   * @param {string} file - Absolute path from {@link FilesystemAppendLog#atRestTargets}
   * @returns {Promise<{plain: number, sealed: number, torn: number, rewritten: boolean}>}
   *   `plain` records sealed now, `sealed` records sealed before, `torn`
   *   lines dropped
   * @throws {KeyUnavailableError} When the batch key cannot be wrapped; the
   *   stream is left as it was
   */
  async sealStreamFile(file) {
    const stream = this._canonicalOfPath(file);
    const tenant = this._atRest.tenant;
    return this._appender.withWriteLock(async () => {
      await this._drain();
      const counts = { plain: 0, sealed: 0, torn: 0, rewritten: false };
      let stat;
      try {
        stat = await fs.stat(file);
      } catch (err) {
        if (err.code === 'ENOENT') return counts;
        throw err;
      }
      // A name of its own, created exclusively: a second process converting
      // the same stream (which the conversion lease prevents) could then at
      // worst rename a complete file over a complete file.
      const scratch = `${file}.${crypto.randomBytes(8).toString('hex')}${SEALING_EXT}`;
      const out = await fs.open(scratch, 'wx');
      let batch = null;
      try {
        let pending = [];
        let pendingBytes = 0;
        const write = async text => {
          pending.push(text);
          pendingBytes += text.length;
          if (pendingBytes < REWRITE_CHUNK_BYTES) return;
          // Completely: a short write must not end up in the renamed file.
          await writeFully(out, pending.join(''));
          pending = [];
          pendingBytes = 0;
        };
        for await (const { text, line } of this._rawLines(file)) {
          if (!line) {
            counts.torn += 1;
          } else if (isKeyLine(line)) {
            await write(`${text}\n`);
          } else if (isSealedLine(line)) {
            counts.sealed += 1;
            await write(`${text}\n`);
          } else if (!Number.isInteger(line.seq) || line.seq <= 0) {
            counts.torn += 1;
          } else {
            if (!batch) {
              const keyProvider = await this._atRest.keyProvider();
              try {
                batch = await newBatchKey({ keyProvider, tenant, stream });
              } catch (error) {
                throw this._atRest.keyFailure(error, `stream ${stream}`) || error;
              }
              await write(`${JSON.stringify(batch.line)}\n`);
            }
            const sealed = sealRecord({
              dataKey: batch.dataKey,
              tenant,
              stream,
              id: batch.id,
              seq: line.seq,
              json: JSON.stringify(line)
            });
            counts.plain += 1;
            await write(`${JSON.stringify(sealed)}\n`);
          }
        }
        if (counts.plain === 0 && counts.torn === 0) return counts;
        if (pending.length > 0) await writeFully(out, pending.join(''));
        await out.sync();
        await out.close();
        await fs.rename(scratch, file);
        await fs.utimes(file, stat.atime, stat.mtime);
        counts.rewritten = true;
        return counts;
      } finally {
        batch?.dataKey.fill(0);
        await out.close().catch(() => {});
        if (!counts.rewritten) await fs.rm(scratch, { force: true });
      }
    });
  }

  /**
   * Count the spill blobs of one blob directory by kind.
   *
   * @param {string} dir - Absolute path from {@link FilesystemAppendLog#atRestTargets}
   * @returns {Promise<{plain: number, sealed: number, bytes: number, largest: number}>}
   *   `bytes` and `largest` describe the plaintext blobs
   */
  async inspectSpillDir(dir) {
    const counts = { plain: 0, sealed: 0, bytes: 0, largest: 0 };
    for (const name of await this._spillNames(dir)) {
      const file = path.join(dir, name);
      let handle;
      try {
        handle = await fs.open(file, 'r');
        const { size } = await handle.stat();
        const head = Buffer.alloc(Math.min(size, 512));
        await handle.read(head, 0, head.length, 0);
        if (isLogBlobEnvelope(head, size)) {
          counts.sealed += 1;
        } else {
          counts.plain += 1;
          counts.bytes += size;
          counts.largest = Math.max(counts.largest, size);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return counts;
  }

  /**
   * Seal the plaintext spill blobs of one blob directory in place, for the
   * conversion. Each blob is replaced in one rename; the modification times
   * of the blobs and of the directory are kept, because the retention sweep
   * judges an orphaned directory by it.
   *
   * @param {string} dir - Absolute path from {@link FilesystemAppendLog#atRestTargets}
   * @returns {Promise<{plain: number, sealed: number}>} `plain` blobs sealed
   *   now, `sealed` blobs sealed before
   * @throws {KeyUnavailableError} When a data key cannot be wrapped
   */
  async sealSpillDir(dir) {
    const stream = this._canonicalOfPath(dir);
    const counts = { plain: 0, sealed: 0 };
    let dirStat;
    try {
      dirStat = await fs.stat(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return counts;
      throw err;
    }
    const names = await this._spillNames(dir);
    const sealOne = async name => {
      const file = path.join(dir, name);
      let stat;
      let stored;
      try {
        stat = await fs.stat(file);
        stored = await fs.readFile(file);
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      if (isLogBlobEnvelope(stored)) {
        counts.sealed += 1;
        return;
      }
      const keyProvider = await this._atRest.keyProvider();
      let sealed;
      try {
        sealed = await sealLogBlob({
          keyProvider,
          tenant: this._atRest.tenant,
          stream,
          name,
          plain: stored
        });
      } catch (error) {
        throw this._atRest.keyFailure(error, `blob ${name} of stream ${stream}`) || error;
      }
      await atomicWriteFile(file, sealed, 'binary');
      await fs.utimes(file, stat.atime, stat.mtime);
      counts.plain += 1;
    };
    try {
      for (let start = 0; start < names.length; start += SPILL_CONCURRENCY) {
        await Promise.all(names.slice(start, start + SPILL_CONCURRENCY).map(sealOne));
      }
    } finally {
      if (counts.plain > 0) await fs.utimes(dir, dirStat.atime, dirStat.mtime).catch(() => {});
    }
    return counts;
  }

  /**
   * Names of the blobs in a blob directory, without scratch files.
   *
   * @param {string} dir - Absolute path of a `.blobs` directory
   * @returns {Promise<string[]>}
   * @private
   */
  async _spillNames(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter(entry => entry.isFile() && !entry.name.startsWith(TEMP_PREFIX))
      .map(entry => entry.name)
      .sort();
  }

  /**
   * The non-empty lines of a stream file with what they parse to.
   *
   * @param {string} file - Absolute path of the stream file
   * @yields {{text: string, line: Object|null}} `line` is null for a line
   *   that is not a JSON object
   * @private
   */
  async *_rawLines(file) {
    const input = createReadStream(file, 'utf8');
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const text of rl) {
        if (!text.trim()) continue;
        let line = null;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) line = parsed;
        } catch {
          // A torn line.
        }
        yield { text, line };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    } finally {
      rl.close();
      input.destroy();
    }
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
