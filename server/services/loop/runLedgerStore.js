/**
 * RunLedgerStore — the persistence half of the run ledger (#2306 track B).
 *
 * `RunLog` keeps the in-memory event stream, the sequence ownership and the
 * cluster-bus routing; everything that touches durable storage lives here, so
 * there is exactly one place that knows where a run's events, its spilled
 * payloads, its per-run lock and its summary are kept.
 *
 * Two backends, chosen per call:
 *
 *   1. **The storage provider** (`storage/bootstrap.js`), when one came up.
 *      Events go to the append log as the stream `run:<runId>`, spilled
 *      payloads become blobs beside it, and the per-day index files are
 *      replaced by documents in the `runs` namespace through
 *      {@link RunSummaryRepository} — an owner-indexed store instead of a
 *      day-partitioned scan.
 *   2. **The ledger's own directory**, the layout every installation already
 *      has on disk: `runs/<runId>.jsonl`, `spill/<runId>/`, `locks/` and
 *      `index/<YYYY-MM-DD>.jsonl`, written through the shared buffered JSONL
 *      appender.
 *
 * The second backend is not dead code once the first exists. It is both the
 * degradation path when no provider is available (a supported state, not an
 * error) *and* the compatibility path for runs written before this release:
 * every read consults it as well — a run continued after the upgrade has
 * events in both backends and they are merged, not chosen between — and
 * retention keeps ageing the old files out.
 * That is what lets a running installation upgrade without its ledger
 * appearing to have been wiped.
 *
 * Two shapes are deliberately preserved rather than modernized:
 *
 * - **Spill references keep their `path` string** (`spill/<runId>/<name>`).
 *   The reference is validated by `spillRefSchema`, copied into the tool
 *   message the model reads, and hashed into `request/header.messagesHash`.
 *   Blobs are addressed by `(stream, name)`, so this module emits the legacy
 *   string on write and derives the name back from it on read.
 * - **Appends are never awaited by the caller.** `RunLog.append()` is
 *   synchronous because SSE projections need `seq` before any I/O;
 *   `AppendLog.append()` queues the record before its first `await`, so
 *   calling it without awaiting preserves both ordering and the current write
 *   path. {@link RunLedgerStore#appendEvent} is therefore the one method here
 *   that returns nothing and reports failures only to the log.
 *
 * @module services/loop/runLedgerStore
 */
import { promises as fs, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import path from 'path';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';
import { createJsonlAppender } from '../../utils/jsonlAppender.js';
import { withFileLock } from '../../utils/fileLock.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { LockTimeoutError } from '../../storage/errors.js';
import { getStorage } from '../../storage/bootstrap.js';
import { RunSummaryRepository, getRunSummaryRepository } from '../runtime/RunSummaryRepository.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

const COMPONENT = 'RunLedgerStore';

/** Debounce for buffered legacy writes when the platform config names none. */
const DEFAULT_FLUSH_MS = 2000;

/**
 * Drop-oldest cap on the legacy write buffers, matching the append log's own:
 * a stalled disk must cost the oldest buffered events, loudly, rather than the
 * whole process to an out-of-memory crash.
 */
const MAX_QUEUE = 20000;

/** Stream kind every run's events are filed under in the append log. */
export const RUN_STREAM_KIND = 'run';

/** Directory prefix a spill reference's `path` keeps, for compatibility. */
const SPILL_DIR = 'spill';

/**
 * Lease for a per-run lock. The critical section is a flush plus one append,
 * and the wait budget matches `utils/fileLock.js`'s default so recovery on a
 * provider without locking behaves the same as recovery on one with it.
 */
const RUN_LOCK_OPTIONS = { ttlMs: 15_000, waitMs: 5_000 };

/**
 * Longest spill name kept, and the character class allowed in it. Identical to
 * the append log's `sanitizeBlobName`, so a name sanitizes to the same file on
 * both backends and a reference minted by one resolves on the other.
 */
const MAX_SPILL_NAME_LENGTH = 120;

/**
 * The append-log stream holding a run's events.
 *
 * @param {string} runId - Validated run id.
 * @returns {string} `run:<runId>`, which the provider files under `run/`.
 */
export function runStreamName(runId) {
  return `${RUN_STREAM_KIND}:${runId}`;
}

/**
 * The lease name guarding sequence recovery for a run.
 *
 * @param {string} runId - Validated run id.
 * @returns {string} Lock name; providers derive their own safe location from it.
 */
export function runLockName(runId) {
  return `runlog:${runId}`;
}

/**
 * The `path` a spill reference carries, whichever backend stored the payload.
 *
 * @param {string} runId - Validated run id.
 * @param {string} name - Sanitized spill name.
 * @returns {string} `spill/<runId>/<name>`.
 */
export function spillRefPath(runId, name) {
  return `${SPILL_DIR}/${runId}/${name}`;
}

/**
 * Reduce a spill reference back to the blob name it was stored under.
 *
 * Spilled payloads are flat inside a run's spill area, so the reference
 * reduces to its basename; anything else is a forged reference.
 *
 * @param {{path?: string}} ref - Reference as it appears on a ledger event.
 * @returns {string} The blob name.
 * @throws {Error} When the reference names no usable file.
 */
export function spillNameFromRef(ref) {
  const name = path.basename(String(ref?.path || ''));
  if (!name || name === '.' || name === '..') {
    throw new Error('Invalid spill reference');
  }
  return name;
}

/**
 * Reduce a caller-supplied spill name to one safe path segment.
 *
 * @param {string} name - Caller-supplied name.
 * @returns {string} The sanitized name.
 */
export function sanitizeSpillName(name) {
  return String(name)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, MAX_SPILL_NAME_LENGTH);
}

/**
 * Validate an id and reduce it to a single path segment. `path.basename` is
 * the sanitizer static analysis recognizes; `isValidId` already rejects
 * separators and traversal, so for valid ids this is the identity.
 *
 * @param {string} id - Run id.
 * @returns {string} The id as one path segment.
 * @throws {Error} When the id is not usable as a file name.
 */
function safeSegment(id) {
  if (!isValidId(id)) {
    throw new Error(`Invalid runId: ${String(id).slice(0, 64)}`);
  }
  return path.basename(String(id));
}

/**
 * Project a run summary document onto the shape `listRuns()` has always
 * returned, so its one consumer (`GET /api/runs`) sees no difference between a
 * run indexed in the `runs` namespace and one still only in a legacy index
 * file.
 *
 * @param {Object} summary - Document from the `runs` namespace.
 * @returns {Object} Listing entry.
 */
function summaryToListing(summary) {
  const entry = {
    ts: summary.endedAt || summary.startedAt,
    runId: summary.runId,
    kind: summary.kind,
    principalId: summary.ownerId ?? null,
    anonymous: summary.anonymous === true,
    parentRunId: summary.parentRunId ?? null,
    refs: summary.refs || {},
    status: summary.status,
    startedAt: summary.startedAt
  };
  // Only present once the run ended, exactly as the merged index entry was.
  if (summary.endedAt) {
    entry.endedAt = summary.endedAt;
    entry.finishReason = summary.finishReason ?? null;
    if (summary.usage) entry.usage = summary.usage;
  }
  return entry;
}

/**
 * Merge two ascending event slices into one, newest write winning a shared
 * sequence number.
 *
 * The only overlap that can occur is a run re-appended through the provider
 * after its legacy file was written, so the provider record is the later of
 * the two and takes the seq.
 *
 * @param {Object[]} legacy - Events from the ledger directory.
 * @param {Object[]} events - Events from the append log.
 * @param {number} limit - Maximum events to return.
 * @returns {Object[]} Ascending by seq, no duplicates.
 */
function mergeEventsBySeq(legacy, events, limit) {
  const bySeq = new Map();
  for (const event of legacy) bySeq.set(event.seq, event);
  for (const event of events) bySeq.set(event.seq, event);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return Number.isFinite(limit) ? merged.slice(0, limit) : merged;
}

/**
 * The day a listing filter compares against, or null when unset.
 *
 * @param {string|Date|undefined} value - Filter bound.
 * @returns {string|null} `YYYY-MM-DD`.
 */
function toDay(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Every durable read and write the run ledger performs.
 *
 * Nothing here consults the `runLog` feature flag: `RunLog` decides whether a
 * run is persisted at all and simply does not call the store when it is not.
 * That keeps the flag in one place and this class purely mechanical.
 */
export class RunLedgerStore {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseDir] - Ledger directory for the legacy backend
   *   (tests point it at a temp dir).
   * @param {number} [opts.flushIntervalMs] - Debounce of the legacy buffers.
   * @param {Object} [opts.logs] - Append-log facet, overriding the provider's.
   * @param {Object} [opts.documents] - Document facet used to build a run
   *   summary repository, overriding the provider's.
   * @param {Object} [opts.locks] - Lock facet, overriding the provider's.
   * @param {Object} [opts.runSummaries] - A ready-made run summary repository.
   * @param {() => Object|null} [opts.resolveProvider] - Storage provider
   *   lookup; injectable so a test can drive both backends.
   */
  constructor({
    baseDir,
    flushIntervalMs,
    logs = null,
    documents = null,
    locks = null,
    runSummaries = null,
    resolveProvider = getStorage
  } = {}) {
    this._baseDir =
      baseDir || path.join(getRootDir(), config.CONTENTS_DIR, config.DATA_DIR, 'run-log');
    this._injectedLogs = logs;
    this._injectedDocuments = documents;
    this._injectedLocks = locks;
    this._injectedSummaries = runSummaries;
    this._resolveProvider = resolveProvider;
    /**
     * Summary writes are serialized rather than fired in parallel: the `put`
     * at run/start and the `patch` at run/end are queued from a synchronous
     * caller, and a patch that overtook its put would resurrect the run as a
     * document with no owner.
     * @type {Promise<void>}
     */
    this._summaryWrites = Promise.resolve();
    /** Repository built from an injected document facet, cached. */
    this._documentSummaries = null;

    const interval = Number(flushIntervalMs) || DEFAULT_FLUSH_MS;
    this._appender = createJsonlAppender({
      getFilePath: entry => this.runFilePath(entry.runId),
      flushIntervalMs: interval,
      maxQueueSize: MAX_QUEUE,
      component: 'RunLog'
    });
    this._indexAppender = createJsonlAppender({
      getFilePath: entry => this._containedPath('index', `${entry.ts.slice(0, 10)}.jsonl`),
      flushIntervalMs: interval,
      maxQueueSize: MAX_QUEUE,
      component: 'RunLogIndex'
    });
  }

  // ── locations ──────────────────────────────────────────────────────────

  /** @returns {string} The ledger directory (legacy layout, and the spill root). */
  get baseDir() {
    return this._baseDir;
  }

  /**
   * Legacy path of a run's event file.
   *
   * @param {string} runId - Run id.
   * @returns {string} Absolute path.
   */
  runFilePath(runId) {
    return this._containedPath('runs', `${safeSegment(runId)}.jsonl`);
  }

  /**
   * Legacy path of a run's spill directory.
   *
   * @param {string} runId - Run id.
   * @returns {string} Absolute path.
   */
  spillDir(runId) {
    return this._containedPath(SPILL_DIR, safeSegment(runId));
  }

  /**
   * Path of a run's lock file, used when no provider lock is available.
   *
   * @param {string} runId - Run id.
   * @returns {string} Absolute path.
   */
  lockPath(runId) {
    return this._containedPath('locks', `${safeSegment(runId)}.lock`);
  }

  /**
   * Join `segments` under the ledger base dir and refuse anything that would
   * resolve outside it (defense in depth on top of the id validation).
   *
   * @param {...string} segments - Path segments.
   * @returns {string} The resolved absolute path.
   * @private
   */
  _containedPath(...segments) {
    const root = path.resolve(this._baseDir);
    const resolved = path.resolve(root, ...segments);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('RunLog path escapes the ledger directory');
    }
    return resolved;
  }

  // ── backend selection ──────────────────────────────────────────────────

  /**
   * The active storage provider, or null when none came up.
   *
   * @returns {Object|null}
   * @private
   */
  _provider() {
    try {
      return this._resolveProvider?.() || null;
    } catch {
      return null;
    }
  }

  /**
   * The append-log facet backing this ledger, or null when writes go to the
   * legacy directory.
   *
   * @returns {Object|null}
   * @private
   */
  _logs() {
    if (this._injectedLogs) return this._injectedLogs;
    return this._provider()?.logs || null;
  }

  /**
   * The lock facet, or null when the per-run lock has to be a lock file.
   *
   * A provider may report `locking: 'none'` — it has the facet but the facet
   * excludes nothing. Recovery would then silently lose its mutual exclusion,
   * so the capability decides, never the provider's name.
   *
   * @returns {Object|null}
   * @private
   */
  _locks() {
    if (this._injectedLocks) return this._injectedLocks;
    const provider = this._provider();
    if (!provider?.locks) return null;
    // Declared without an initializer on purpose: the try either assigns it
    // (a provider without getCapabilities yields undefined, which the ?? turns
    // into 'none') or the catch returns, so a default here would be dead.
    let locking;
    try {
      locking = provider.getCapabilities?.().locking ?? 'none';
    } catch {
      return null;
    }
    return locking === 'none' ? null : provider.locks;
  }

  /**
   * The run summary repository backing the `runs` namespace, or null when
   * summaries have to go to the legacy per-day index.
   *
   * @returns {Object|null}
   * @private
   */
  _summaries() {
    if (this._injectedSummaries) return this._injectedSummaries;
    if (this._injectedDocuments) {
      if (!this._documentSummaries) {
        this._documentSummaries = new RunSummaryRepository({
          documents: this._injectedDocuments,
          locks: this._injectedLocks
        });
      }
      return this._documentSummaries;
    }
    return this._provider() ? getRunSummaryRepository() : null;
  }

  // ── events ─────────────────────────────────────────────────────────────

  /**
   * Persist one already-sequenced event.
   *
   * Returns nothing and never throws: `RunLog.append()` is synchronous and
   * fire-and-forget, and the append log accepts the record before its first
   * `await`, so the queue order matches the sequence order without the caller
   * having to wait.
   *
   * @param {string} runId - Run id.
   * @param {{seq:number, ts:string, runId:string, type:string, data:Object}} event
   *   The event, exactly as it is handed to subscribers.
   * @returns {void}
   */
  appendEvent(runId, event) {
    const logs = this._logs();
    if (!logs) {
      this._appender.append(event);
      return;
    }
    void Promise.resolve(logs.append(runStreamName(runId), event, event.seq)).catch(error =>
      logger.warn('RunLog: failed to persist an event', {
        component: COMPONENT,
        runId,
        type: event?.type,
        error: error.message
      })
    );
  }

  /**
   * A run's events in ascending sequence order.
   *
   * A run whose history spans the upgrade has events in **both** backends:
   * its start and its earlier turns are in the legacy file, and anything
   * appended since — `appendRecovered` continues the legacy sequence and then
   * writes through the provider — is in the stream. So the two are merged
   * rather than chosen between; reading only the non-empty one would hide
   * everything the other holds, which for such a run is its whole history.
   *
   * @param {string} runId - Run id.
   * @param {Object} [opts]
   * @param {number} [opts.afterSeq=0] - Return only events with a greater seq.
   * @param {number} [opts.limit=Infinity] - Maximum number of events.
   * @returns {Promise<Object[]>} The events; `[]` when the run has none.
   */
  async readEvents(runId, { afterSeq = 0, limit = Infinity } = {}) {
    const logs = this._logs();
    if (!logs) return this._legacyReadEvents(runId, { afterSeq, limit });
    // The common case — a run written entirely through the provider — costs
    // one `access` miss and keeps the requested limit on the provider read.
    if (!(await this._hasLegacyRunFile(runId))) {
      return logs.read(runStreamName(runId), { afterSeq, limit });
    }
    const [legacy, events] = await Promise.all([
      this._legacyReadEvents(runId, { afterSeq, limit: Infinity }),
      logs.read(runStreamName(runId), { afterSeq, limit: Infinity })
    ]);
    return mergeEventsBySeq(legacy, events, limit);
  }

  /**
   * The highest persisted sequence number for a run, or 0.
   *
   * The maximum across both backends, so a run that spans the upgrade never
   * hands a recovering worker a sequence number the legacy file already used.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<number>}
   */
  async lastSeq(runId) {
    const logs = this._logs();
    if (!logs) return (await this._legacyLastEvent(runId))?.seq || 0;
    const seq = await logs.lastSeq(runStreamName(runId));
    if (!(await this._hasLegacyRunFile(runId))) return seq;
    return Math.max(seq, (await this._legacyLastEvent(runId))?.seq || 0);
  }

  /**
   * The last persisted event of a run, or null.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<Object|null>}
   */
  async lastEvent(runId) {
    const logs = this._logs();
    if (!logs) return this._legacyLastEvent(runId);
    const stream = runStreamName(runId);
    const seq = await logs.lastSeq(stream);
    const legacy = (await this._hasLegacyRunFile(runId))
      ? await this._legacyLastEvent(runId)
      : null;
    if (seq > 0 && seq >= (legacy?.seq || 0)) {
      const [event] = await logs.read(stream, { afterSeq: seq - 1, limit: 1 });
      if (event) return event;
    }
    return legacy;
  }

  /**
   * A run's `run/start` event, without reading the rest of it.
   *
   * For a run that spans the upgrade the stream's first record is whatever
   * was appended after it — never the start — so a provider read that does
   * not find a `run/start` falls through to the legacy file rather than
   * answering "this run never started".
   *
   * @param {string} runId - Run id.
   * @returns {Promise<Object|null>} The event, or null when the run has none.
   */
  async readStart(runId) {
    const logs = this._logs();
    if (logs) {
      const [first] = await logs.read(runStreamName(runId), { afterSeq: 0, limit: 1 });
      if (first?.type === RUN_LOG_EVENTS.RUN_START) return first;
    }
    const line = await this._legacyFirstLine(runId);
    if (!line) return null;
    try {
      const event = JSON.parse(line);
      return event?.type === RUN_LOG_EVENTS.RUN_START ? event : null;
    } catch {
      return null;
    }
  }

  // ── spill ──────────────────────────────────────────────────────────────

  /**
   * Store a payload too large to keep inline and return the reference that
   * goes on the event.
   *
   * The reference keeps its legacy `path` string on both backends — it is
   * schema-validated, copied into the tool message the model reads, and hashed
   * into `request/header.messagesHash`, so its shape is part of the contract.
   *
   * @param {string} runId - Run id.
   * @param {string} name - Caller-supplied name; sanitized.
   * @param {string} body - Serialized payload.
   * @param {string} contentType - MIME type recorded on the reference.
   * @returns {Promise<{path:string, bytes:number, sha256:string, contentType:string}>}
   */
  async putSpill(runId, name, body, contentType) {
    const safeName = sanitizeSpillName(name);
    const logs = this._logs();
    if (logs) {
      const blob = await logs.putBlob(runStreamName(runId), safeName, body, { contentType });
      return {
        path: spillRefPath(runId, blob.name),
        bytes: blob.bytes,
        sha256: blob.sha256,
        contentType
      };
    }
    const dir = this.spillDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const file = this._containedPath(SPILL_DIR, safeSegment(runId), path.basename(safeName));
    await fs.writeFile(file, body, 'utf8');
    return {
      path: path.relative(this._baseDir, file),
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: sha256Hex(body),
      contentType
    };
  }

  /**
   * Read a spilled payload back as text.
   *
   * @param {string} runId - Run id.
   * @param {{path?: string}} ref - Reference taken off a ledger event.
   * @returns {Promise<string>} The payload.
   * @throws {Error} When the reference is forged or the payload is gone.
   */
  async readSpill(runId, ref) {
    const name = spillNameFromRef(ref);
    const logs = this._logs();
    if (logs) {
      const blob = await logs.getBlob(runStreamName(runId), name);
      if (blob) return blob.toString('utf8');
    }
    // Either no provider, or a payload spilled before the move: the legacy
    // file is authoritative, and its ENOENT is the error callers already see.
    return fs.readFile(this._containedPath(SPILL_DIR, safeSegment(runId), name), 'utf8');
  }

  // ── run summaries ──────────────────────────────────────────────────────

  /**
   * Record that a run started, so it appears in listings before it ends.
   *
   * Queued rather than awaited: the caller is on the request path and the
   * previous index writer was buffered too. {@link RunLedgerStore#flush} waits
   * for what has been queued so far, which is what makes a listing taken right
   * after a start deterministic.
   *
   * @param {Object} summary
   * @param {string} summary.runId - Run id.
   * @param {string} summary.kind - Run kind.
   * @param {string} summary.principalId - Ledger principal that owns the run.
   * @param {string} [summary.identityMode] - Mode the principal was resolved in.
   * @param {boolean} summary.anonymous - Whether the principal is anonymous.
   * @param {string|null} [summary.parentRunId] - Parent run, when nested.
   * @param {Object} [summary.refs] - Cross-references (chatId, appId, …).
   * @param {string} [summary.model] - Model the run was started with.
   * @param {string} summary.startedAt - ISO timestamp.
   * @returns {void}
   */
  recordRunStart(summary) {
    const summaries = this._summaries();
    if (!summaries) {
      this._indexAppender.append({
        ts: summary.startedAt,
        runId: summary.runId,
        kind: summary.kind,
        principalId: summary.principalId,
        anonymous: summary.anonymous,
        parentRunId: summary.parentRunId || null,
        refs: summary.refs,
        status: 'running'
      });
      return;
    }
    // Merged, never replaced: for a workflow or agent run the execution id is
    // the run id, so `ExecutionRegistry.register` writes the same document
    // from a queue of its own. A replace here would erase the workflow name,
    // the input preview, the models and who triggered the run whenever the
    // registry got there first.
    this._queueSummaryWrite(() =>
      summaries.merge(summary.runId, {
        runId: summary.runId,
        kind: summary.kind,
        ownerId: summary.principalId,
        identityMode: summary.identityMode || null,
        anonymous: summary.anonymous === true,
        parentRunId: summary.parentRunId || null,
        refs: summary.refs || {},
        source: 'ledger',
        status: 'running',
        startedAt: summary.startedAt,
        updatedAt: summary.startedAt,
        model: summary.model || null
      })
    );
  }

  /**
   * Record that a run ended.
   *
   * @param {Object} summary
   * @param {string} summary.runId - Run id.
   * @param {string} summary.kind - Run kind.
   * @param {string|null} summary.principalId - Ledger principal.
   * @param {boolean} summary.anonymous - Whether the principal is anonymous.
   * @param {string} summary.status - Terminal status.
   * @param {string|null} summary.finishReason - Why it finished.
   * @param {Object} [summary.usage] - Token usage rollup.
   * @param {string} summary.endedAt - ISO timestamp.
   * @returns {void}
   */
  recordRunEnd(summary) {
    const entry = {
      ts: summary.endedAt,
      runId: summary.runId,
      kind: summary.kind,
      principalId: summary.principalId,
      anonymous: summary.anonymous,
      status: summary.status,
      finishReason: summary.finishReason ?? null,
      usage: summary.usage,
      endedAt: summary.endedAt
    };
    const summaries = this._summaries();
    if (!summaries) {
      this._indexAppender.append(entry);
      return;
    }
    this._queueSummaryWrite(async () => {
      const patched = await summaries.patch(summary.runId, {
        status: summary.status,
        finishReason: summary.finishReason ?? null,
        usage: summary.usage,
        endedAt: summary.endedAt,
        updatedAt: summary.endedAt
      });
      // A run whose start predates the namespace has no document to patch —
      // the repository refuses to invent one, because a summary with no
      // principal is worse than none. Its end belongs where its start went, so
      // that a run in flight across the upgrade does not stay 'running' for
      // ever in the listing.
      if (!patched && (await this._hasLegacyIndex())) this._indexAppender.append(entry);
    });
  }

  /**
   * Record that a run is gone: the document goes, and a tombstone is appended
   * to the legacy index when the installation has one.
   *
   * The tombstone is the only way to hide a run that was recorded in an
   * append-only index file, so a delete that skipped it would leave the run
   * listed for as long as retention keeps that file.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<void>} Resolves once the record is written.
   */
  async recordRunDeleted(runId) {
    const summaries = this._summaries();
    if (summaries) await this._queueSummaryWrite(() => summaries.remove(runId));
    if (summaries && !(await this._hasLegacyIndex())) return;
    this._indexAppender.append({ ts: new Date().toISOString(), runId, deleted: true });
    await this._indexAppender.flush();
  }

  /**
   * List runs, newest first, excluding anonymous ones.
   *
   * The namespace is the index; the legacy per-day files are read as well and
   * lose every conflict, so runs that predate the import stay listed until
   * retention removes them.
   *
   * @param {Object} [opts]
   * @param {string|Date} [opts.from] - Earliest day to include.
   * @param {string|Date} [opts.to] - Latest day to include.
   * @param {string} [opts.kind] - Restrict to one run kind.
   * @param {string} [opts.principalId] - Restrict to one principal.
   * @param {number} [opts.limit=100] - Maximum entries returned.
   * @returns {Promise<Object[]>}
   */
  async listRuns({ from, to, kind, principalId, limit = 100 } = {}) {
    const fromDay = toDay(from);
    const toDayValue = toDay(to);
    const { byRun, deleted } = await this._legacyIndexEntries(fromDay, toDayValue);

    const summaries = this._summaries();
    if (summaries) {
      for (const summary of await this._scanSummaries({ kind, principalId })) {
        if (summary.anonymous === true) continue;
        const entry = summaryToListing(summary);
        const day = String(entry.startedAt || entry.ts || '').slice(0, 10);
        if (fromDay && day < fromDay) continue;
        if (toDayValue && day > toDayValue) continue;
        deleted.delete(entry.runId);
        byRun.set(entry.runId, entry);
      }
    }

    let runs = [...byRun.values()].filter(r => !deleted.has(r.runId));
    if (kind) runs = runs.filter(r => r.kind === kind);
    if (principalId) runs = runs.filter(r => r.principalId === principalId);
    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return runs.slice(0, limit);
  }

  // ── deletion and retention ─────────────────────────────────────────────

  /**
   * Remove everything stored for a run: its events, its spilled payloads and
   * its summary, on both backends.
   *
   * The delete hooks are the caller's business — `RunLog` runs them, because
   * they fire even when persistence is off.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<{deleted: boolean, removed: string[]}>} What went, in the
   *   vocabulary `deleteRun`'s `cascaded` list uses.
   */
  async deleteRun(runId) {
    const removed = [];
    let deleted = false;
    const logs = this._logs();
    if (logs && (await logs.deleteStream(runStreamName(runId)))) deleted = true;

    await this._appender.withWriteLock(async () => {
      await this._appender.drainToDisk().catch(() => {});
      try {
        await fs.unlink(this.runFilePath(runId));
        deleted = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await fs.rm(this.spillDir(runId), { recursive: true, force: true }).catch(() => {});
    });
    if (deleted) removed.push('run-file');
    removed.push('spill');

    await this.recordRunDeleted(runId);
    return { deleted, removed };
  }

  /**
   * Retention sweep: remove every run last touched before `cutoffMs`.
   *
   * Summaries drive the provider pass because the append log's own sweep
   * reports counts, not ids, and the ledger's delete hooks need ids. Whatever
   * the summaries do not cover — a stream whose run was never summarized —
   * is caught by `logs.sweep()` afterwards, and the legacy directory is aged
   * out by file modification time exactly as before.
   *
   * @param {number} cutoffMs - Epoch milliseconds; older runs go.
   * @returns {Promise<{removed: number, cascadeIds: string[]}>} How many runs
   *   were removed and which ids the caller must run its cascade for.
   */
  async cleanup(cutoffMs) {
    let removed = 0;
    const cascadeIds = new Set();

    const summaries = this._summaries();
    if (summaries) {
      // `includeAnonymous`: the listings hide anonymous runs by design, but a
      // sweep that inherited that filter would never delete their documents
      // and never run the delete cascade for them — so an anonymous chat
      // would leave a summary behind for ever, and the interactions it raised
      // would never be reclaimed, while its events were swept out underneath.
      for (const summary of await this._scanSummaries({ includeAnonymous: true })) {
        const touched = Date.parse(summary.endedAt || summary.updatedAt || summary.startedAt || '');
        if (!Number.isFinite(touched) || touched >= cutoffMs) continue;
        // deleteRun drops the stream, the blobs, any legacy leftovers and the
        // summary itself, so the run cannot come back through either backend.
        await this.deleteRun(summary.runId);
        cascadeIds.add(summary.runId);
        removed += 1;
      }
    }
    const logs = this._logs();
    if (logs) {
      // Scoped to this ledger's own streams. The sweep is driven from
      // `runLog.retentionDays`, which is a policy about runs — store-wide, it
      // would delete any other consumer's streams on that policy and count
      // them into `removed`, so the number in the log would not even show it
      // happening.
      const swept = await logs.sweep({ olderThan: cutoffMs, kind: RUN_STREAM_KIND });
      removed += swept?.streams || 0;
    }

    removed += await this._legacyCleanup(cutoffMs, cascadeIds);
    return { removed, cascadeIds: [...cascadeIds] };
  }

  // ── locking ────────────────────────────────────────────────────────────

  /**
   * Run `fn` while holding the run's recovery lock.
   *
   * A provider lock rejects with {@link LockTimeoutError} when the lease could
   * not be taken; `utils/fileLock.js` instead warns and continues. The second
   * behaviour is the one the recovery path has always had — refusing to append
   * an answer because a peer is slow would lose the event — so a timeout is
   * downgraded to the same warning rather than propagated.
   *
   * @param {string} runId - Run id.
   * @param {() => Promise<T>|T} fn - The critical section.
   * @returns {Promise<T>} Whatever `fn` returned.
   * @template T
   */
  async withRunLock(runId, fn) {
    const locks = this._locks();
    if (!locks) {
      return withFileLock(this.lockPath(runId), fn, { component: 'RunLog' });
    }
    try {
      return await locks.withLock(runLockName(runId), fn, RUN_LOCK_OPTIONS);
    } catch (error) {
      if (!(error instanceof LockTimeoutError) && error?.code !== 'LOCK_TIMEOUT') throw error;
      logger.warn('RunLog: lock wait exceeded; continuing without the lock', {
        component: COMPONENT,
        runId
      });
      return fn();
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /**
   * Drain everything this store has buffered: the legacy appenders, the queued
   * summary writes and the provider's append log.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this._appender.flush();
    await this._indexAppender.flush();
    // Snapshot the chain: writes queued while we wait belong to the next flush,
    // and awaiting a growing chain would never settle under a steady load.
    const queued = this._summaryWrites;
    await queued;
    const logs = this._logs();
    if (logs) await logs.flush();
  }

  /**
   * Stop the legacy buffers' timers. The provider is shared and owned by the
   * storage bootstrap, so it is deliberately left running.
   *
   * @returns {void}
   */
  stop() {
    this._appender.stop();
    this._indexAppender.stop();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Queue a summary write behind the ones already pending.
   *
   * @param {() => Promise<unknown>} fn - The write.
   * @returns {Promise<void>} Settles when this write has been attempted.
   * @private
   */
  _queueSummaryWrite(fn) {
    this._summaryWrites = this._summaryWrites.then(fn).then(
      () => undefined,
      error => {
        logger.warn('RunLog: failed to record a run summary', {
          component: COMPONENT,
          error: error.message
        });
      }
    );
    return this._summaryWrites;
  }

  /**
   * Load run summaries, narrowed by the repository where it can be (an owner
   * listing is indexed; a cross-owner one is a scan).
   *
   * No `limit` is passed: the repository bounds its own scan and logs when the
   * bound truncates, and paging here would cut the set *before* the day-range
   * filter and the final `limit` are applied.
   *
   * @param {{kind?: string, principalId?: string, includeAnonymous?: boolean}} filter
   *   Narrowing hints. `includeAnonymous` is for the retention sweep only:
   *   an anonymous run is never listed, but it must still age out.
   * @returns {Promise<Object[]>} The summaries, newest first.
   * @private
   */
  async _scanSummaries({ kind, principalId, includeAnonymous = false }) {
    const summaries = this._summaries();
    if (!summaries) return [];
    const page = principalId
      ? await summaries.listByOwner(principalId, { kind, archived: 'all' })
      : await summaries.listAll({ includeAnonymous });
    return page?.items || [];
  }

  /**
   * Whether this installation carries legacy per-day index files.
   *
   * Used to decide whether a write only the legacy index can express (a
   * tombstone, an end for a run that started before the namespace) is worth
   * making. A fresh installation never has the directory, so it never gains
   * one; an upgraded one keeps both halves consistent until retention removes
   * the files.
   *
   * @returns {Promise<boolean>}
   * @private
   */
  async _hasLegacyIndex() {
    try {
      await fs.access(this._containedPath('index'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this run has events in the ledger directory as well.
   *
   * One `access` call, so the reads can ask it before deciding whether they
   * have to merge the two backends: a fresh installation pays a miss, and an
   * upgraded one pays it only for the runs that actually predate the move.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<boolean>}
   * @private
   */
  async _hasLegacyRunFile(runId) {
    // A run started while no provider was up can still be in the buffer.
    if (this._appender.queueLength() > 0) await this._appender.flush();
    try {
      await fs.access(this.runFilePath(runId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a run's events out of the legacy file.
   *
   * @param {string} runId - Run id.
   * @param {{afterSeq: number, limit: number}} opts - Slice to read.
   * @returns {Promise<Object[]>}
   * @private
   */
  async _legacyReadEvents(runId, { afterSeq, limit }) {
    // Only flush when something is buffered: a read must never cost a disk
    // write when the appender is idle.
    if (this._appender.queueLength() > 0) await this._appender.flush();
    const file = this.runFilePath(runId);
    try {
      await fs.access(file);
    } catch {
      return [];
    }
    const out = [];
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.seq > afterSeq) {
        out.push(event);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * The first line of a run's legacy file, read without touching the rest.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<string|null>}
   * @private
   */
  async _legacyFirstLine(runId) {
    const file = this.runFilePath(runId);
    let line = await readFirstLine(file);
    if (line === null && this._appender.queueLength() > 0) {
      // The start may still sit in the buffer.
      await this._appender.flush();
      line = await readFirstLine(file);
    }
    return line;
  }

  /**
   * The last complete event in a run's legacy file, read from its tail.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<Object|null>}
   * @private
   */
  async _legacyLastEvent(runId) {
    if (this._appender.queueLength() > 0) await this._appender.flush();
    return readLastEvent(this.runFilePath(runId));
  }

  /**
   * Merge the legacy per-day index files into a run map plus a tombstone set.
   *
   * @param {string|null} fromDay - Earliest day, inclusive.
   * @param {string|null} toDayValue - Latest day, inclusive.
   * @returns {Promise<{byRun: Map<string, Object>, deleted: Set<string>}>}
   * @private
   */
  async _legacyIndexEntries(fromDay, toDayValue) {
    const byRun = new Map();
    const deleted = new Set();
    const dir = this._containedPath('index');
    let files;
    try {
      files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl')).sort();
    } catch {
      return { byRun, deleted };
    }
    for (const file of files) {
      const day = file.slice(0, 10);
      if (fromDay && day < fromDay) continue;
      if (toDayValue && day > toDayValue) continue;
      const rl = createInterface({
        input: createReadStream(path.join(dir, file), 'utf8'),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.deleted) {
          deleted.add(entry.runId);
          byRun.delete(entry.runId);
          continue;
        }
        if (entry.anonymous) continue;
        if (deleted.has(entry.runId)) continue;
        const prev = byRun.get(entry.runId) || {};
        byRun.set(entry.runId, { ...prev, ...entry, startedAt: prev.startedAt || entry.ts });
      }
    }
    return { byRun, deleted };
  }

  /**
   * Age the legacy directory out by file modification time and drop index
   * files older than the cut-off.
   *
   * @param {number} cutoffMs - Epoch milliseconds.
   * @param {Set<string>} cascadeIds - Collects the ids that were removed.
   * @returns {Promise<number>} How many run files went.
   * @private
   */
  async _legacyCleanup(cutoffMs, cascadeIds) {
    let removed = 0;
    await this._appender.withWriteLock(async () => {
      await this._appender.drainToDisk().catch(() => {});
      const runsDir = this._containedPath('runs');
      let files = [];
      try {
        files = await fs.readdir(runsDir);
      } catch {
        return;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const abs = path.join(runsDir, file);
        try {
          const stat = await fs.stat(abs);
          if (stat.mtimeMs >= cutoffMs) continue;
          const runId = file.replace(/\.jsonl$/, '');
          await fs.unlink(abs);
          await fs.rm(path.join(this._baseDir, SPILL_DIR, runId), {
            recursive: true,
            force: true
          });
          if (isValidId(runId)) cascadeIds.add(runId);
          removed += 1;
        } catch {
          /* ignore individual failures */
        }
      }
      const indexDir = this._containedPath('index');
      try {
        const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
        for (const file of await fs.readdir(indexDir)) {
          if (file.endsWith('.jsonl') && file.slice(0, 10) < cutoffDay) {
            await fs.unlink(path.join(indexDir, file)).catch(() => {});
          }
        }
      } catch {
        /* ignore */
      }
    });
    return removed;
  }
}

/**
 * sha256 hex digest of a string, for spill references written by the legacy
 * backend (the append log computes its own).
 *
 * @param {string} value - Content to hash.
 * @returns {string} Hex digest.
 */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The first line of a file, read in 16 KiB chunks so a long ledger costs one
 * read rather than a full parse.
 *
 * @param {string} file - Absolute path.
 * @returns {Promise<string|null>} The line, or null when the file is missing
 *   or empty.
 */
async function readFirstLine(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const chunks = [];
    const buf = Buffer.alloc(16 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      const text = buf.toString('utf8', 0, bytesRead);
      const nl = text.indexOf('\n');
      if (nl >= 0) {
        chunks.push(text.slice(0, nl));
        return chunks.join('');
      }
      chunks.push(text);
      position += bytesRead;
    }
    return chunks.length ? chunks.join('') : null;
  } finally {
    await handle.close();
  }
}

/**
 * The last complete JSON record in a JSONL file, read from its tail (the last
 * 64 KiB, growing backwards when a line is longer).
 *
 * @param {string} file - Absolute path.
 * @returns {Promise<Object|null>} The record, or null when there is none.
 */
async function readLastEvent(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    let span = Math.min(size, 64 * 1024);
    for (;;) {
      const buf = Buffer.alloc(span);
      await handle.read(buf, 0, span, size - span);
      const lines = buf
        .toString('utf8')
        .split('\n')
        .filter(l => l.trim());
      // The first line of the chunk may be cut; use it only when the chunk
      // starts at the beginning of the file.
      const usable = span === size ? lines : lines.slice(1);
      for (let i = usable.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(usable[i]);
        } catch {
          /* a partial line: keep looking backwards */
        }
      }
      if (span >= size) return null;
      span = Math.min(size, span * 4);
    }
  } finally {
    await handle.close();
  }
}

export default RunLedgerStore;
