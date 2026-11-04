// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * RunLedgerStore — the persistence half of the run ledger (#2306 track B).
 *
 * `RunLog` keeps the in-memory event stream, the sequence ownership and the
 * cluster-bus routing; everything that touches durable storage lives here, so
 * there is exactly one place that knows where a run's events, its spilled
 * payloads, its per-run lock and its summary are kept.
 *
 * Everything goes through the storage provider (`storage/bootstrap.js`), which
 * is mandatory: events go to the append log as the stream `run:<runId>`,
 * spilled payloads become blobs beside it, and summaries are documents in the
 * `runs` namespace through {@link RunSummaryRepository} — an owner-indexed store
 * instead of a day-partitioned scan. Runs recorded before the storage provider
 * (5.5.2) are carried over once by migration V219.
 *
 * Two shapes are deliberately preserved rather than modernized:
 *
 * - **Spill references keep their `path` string** (`spill/<runId>/<name>`).
 *   The reference is validated by `spillRefSchema`, copied into the tool
 *   message the model reads, and hashed into `request/header.messagesHash`.
 *   Blobs are addressed by `(stream, name)`, so this module emits that string
 *   on write and derives the name back from it on read.
 * - **Appends are never awaited by the caller.** `RunLog.append()` is
 *   synchronous because SSE projections need `seq` before any I/O;
 *   `AppendLog.append()` queues the record before its first `await`, so
 *   calling it without awaiting preserves ordering. {@link RunLedgerStore#appendEvent}
 *   is therefore the one method here that returns nothing and reports failures
 *   only to the log.
 *
 * @module services/loop/runLedgerStore
 */
import path from 'node:path';
import logger from '../../utils/logger.js';
import { LockTimeoutError } from '../../storage/errors.js';
import { requireStorage } from '../../storage/bootstrap.js';
import { RunSummaryRepository, getRunSummaryRepository } from '../runtime/RunSummaryRepository.js';

const COMPONENT = 'RunLedgerStore';

/**
 * Run kinds whose summary *is* the execution record, so age alone must not
 * reclaim it. Since the registry moved into the `runs` namespace, deleting one
 * of these deletes the execution.
 */
const EXECUTION_KINDS = new Set(['workflow', 'agent']);

/**
 * Statuses an execution can be swept at. Everything else — `running`,
 * `paused`, `pending` — is still someone's to finish.
 */
const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Whether the retention sweep may reclaim this summary on age alone.
 *
 * A chat run's summary is history, and history ages out. A workflow or agent
 * run's summary is the execution record: a run paused on a human node with no
 * timeout is not terminal, so `workflowRetention` deliberately spares it, and
 * the ledger sweep must not delete it from underneath it either — it would
 * vanish from `getByUser`, the admin list and `/pending` while its
 * `workflow-state` document survived. Reclaiming a long-paused run has to
 * reclaim it whole (expire the interaction, fail the run, let workflow
 * retention take the terminal state), not remove its index.
 *
 * @param {Object} summary - Stored run summary.
 * @returns {boolean} Whether age is enough to delete it.
 */
function sweepableByAge(summary) {
  if (!EXECUTION_KINDS.has(summary?.kind)) return true;
  return TERMINAL_EXECUTION_STATUSES.has(summary?.status);
}

/** Stream kind every run's events are filed under in the append log. */
export const RUN_STREAM_KIND = 'run';

/** Directory prefix a spill reference's `path` keeps. */
const SPILL_DIR = 'spill';

/**
 * Lease for a per-run lock. The critical section is a flush plus one append,
 * and the wait budget matches what recovery has always had.
 */
const RUN_LOCK_OPTIONS = { ttlMs: 15_000, waitMs: 5_000 };

/**
 * Longest spill name kept, and the character class allowed in it. Identical to
 * the append log's `sanitizeBlobName`, so a name sanitizes to the same blob.
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
 * The `path` a spill reference carries.
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
 * Project a run summary document onto the shape `listRuns()` returns.
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
  // Only present once the run ended.
  if (summary.endedAt) {
    entry.endedAt = summary.endedAt;
    entry.finishReason = summary.finishReason ?? null;
    if (summary.usage) entry.usage = summary.usage;
  }
  return entry;
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
   * @param {Object} [opts.logs] - Append-log facet, overriding the provider's.
   * @param {Object} [opts.documents] - Document facet used to build a run
   *   summary repository, overriding the provider's.
   * @param {Object} [opts.locks] - Lock facet, overriding the provider's.
   * @param {Object} [opts.runSummaries] - A ready-made run summary repository.
   * @param {() => Object} [opts.resolveProvider] - Storage provider lookup
   *   (default: the bootstrapped one; throws when storage is not up).
   */
  constructor({
    logs = null,
    documents = null,
    locks = null,
    runSummaries = null,
    resolveProvider = requireStorage
  } = {}) {
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
  }

  // ── facets ─────────────────────────────────────────────────────────────

  /**
   * The append-log facet backing this ledger.
   *
   * @returns {Object}
   * @private
   */
  _logs() {
    return this._injectedLogs || this._resolveProvider().logs;
  }

  /**
   * The lock facet.
   *
   * @returns {Object}
   * @private
   */
  _locks() {
    return this._injectedLocks || this._resolveProvider().locks;
  }

  /**
   * The run summary repository backing the `runs` namespace.
   *
   * @returns {Object}
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
    this._resolveProvider();
    return getRunSummaryRepository();
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
    try {
      void Promise.resolve(this._logs().append(runStreamName(runId), event, event.seq)).catch(
        error => this._warnAppend(runId, event, error)
      );
    } catch (error) {
      this._warnAppend(runId, event, error);
    }
  }

  _warnAppend(runId, event, error) {
    logger.warn('RunLog: failed to persist an event', {
      component: COMPONENT,
      runId,
      type: event?.type,
      error: error.message
    });
  }

  /**
   * A run's events in ascending sequence order.
   *
   * @param {string} runId - Run id.
   * @param {Object} [opts]
   * @param {number} [opts.afterSeq=0] - Return only events with a greater seq.
   * @param {number} [opts.limit=Infinity] - Maximum number of events.
   * @returns {Promise<Object[]>} The events; `[]` when the run has none.
   */
  async readEvents(runId, { afterSeq = 0, limit = Infinity } = {}) {
    return this._logs().read(runStreamName(runId), { afterSeq, limit });
  }

  /**
   * The highest persisted sequence number for a run, or 0.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<number>}
   */
  async lastSeq(runId) {
    return this._logs().lastSeq(runStreamName(runId));
  }

  /**
   * The last persisted event of a run, or null.
   *
   * One parse of the stream: `AppendLog.lastRecord` hands back the record it
   * found the maximum in, where `lastSeq` followed by a `read` for that one
   * record would scan the file twice.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<Object|null>}
   */
  async lastEvent(runId) {
    return (await this._logs().lastRecord(runStreamName(runId))) || null;
  }

  /**
   * A run's `run/start` event, or null.
   *
   * `AppendLog.read` returns the lowest sequence numbers above `afterSeq`, so
   * the first record of a stream is its start; a stream that begins with
   * anything else (a run whose start was never written) has none.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<Object|null>} The event, or null when the run has none.
   */
  async readStart(runId) {
    const [first] = await this._logs().read(runStreamName(runId), { afterSeq: 0, limit: 1 });
    return first?.type === 'run/start' ? first : null;
  }

  // ── spill ──────────────────────────────────────────────────────────────

  /**
   * Store a payload too large to keep inline and return the reference that
   * goes on the event.
   *
   * @param {string} runId - Run id.
   * @param {string} name - Caller-supplied name; sanitized.
   * @param {string} body - Serialized payload.
   * @param {string} contentType - MIME type recorded on the reference.
   * @returns {Promise<{path:string, bytes:number, sha256:string, contentType:string}>}
   */
  async putSpill(runId, name, body, contentType) {
    const safeName = sanitizeSpillName(name);
    const blob = await this._logs().putBlob(runStreamName(runId), safeName, body, { contentType });
    return {
      path: spillRefPath(runId, blob.name),
      bytes: blob.bytes,
      sha256: blob.sha256,
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
    const blob = await this._logs().getBlob(runStreamName(runId), name);
    if (!blob) {
      const error = new Error(`Spilled payload not found: ${name}`);
      error.code = 'ENOENT';
      throw error;
    }
    return blob.toString('utf8');
  }

  // ── run summaries ──────────────────────────────────────────────────────

  /**
   * Record that a run started, so it appears in listings before it ends.
   *
   * Queued rather than awaited: the caller is on the request path.
   * {@link RunLedgerStore#flush} waits for what has been queued so far, which
   * is what makes a listing taken right after a start deterministic.
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
    // Merged, never replaced: for a workflow or agent run the execution id is
    // the run id, so `ExecutionRegistry.register` writes the same document
    // from a queue of its own. A replace here would erase the workflow name,
    // the input preview, the models and who triggered the run whenever the
    // registry got there first.
    void this._queueSummaryWrite(() =>
      this._summaries().merge(summary.runId, {
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
   * @param {string} summary.status - Terminal status.
   * @param {string|null} summary.finishReason - Why it finished.
   * @param {Object} [summary.usage] - Token usage rollup.
   * @param {string} summary.endedAt - ISO timestamp.
   * @returns {void}
   */
  recordRunEnd(summary) {
    void this._queueSummaryWrite(() =>
      this._summaries().patch(summary.runId, {
        status: summary.status,
        finishReason: summary.finishReason ?? null,
        usage: summary.usage,
        endedAt: summary.endedAt,
        updatedAt: summary.endedAt
      })
    );
  }

  /**
   * Record that a run is gone: its summary document is removed.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<void>} Resolves once the record is written.
   */
  async recordRunDeleted(runId) {
    await this._queueSummaryWrite(() => this._summaries().remove(runId));
  }

  /**
   * List runs, newest first, excluding anonymous ones.
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
    const byRun = new Map();
    for (const summary of await this._scanSummaries({ kind, principalId })) {
      if (summary.anonymous === true) continue;
      const entry = summaryToListing(summary);
      const day = String(entry.startedAt || entry.ts || '').slice(0, 10);
      if (fromDay && day < fromDay) continue;
      if (toDayValue && day > toDayValue) continue;
      byRun.set(entry.runId, entry);
    }

    let runs = [...byRun.values()];
    if (kind) runs = runs.filter(r => r.kind === kind);
    if (principalId) runs = runs.filter(r => r.principalId === principalId);
    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return runs.slice(0, limit);
  }

  // ── deletion and retention ─────────────────────────────────────────────

  /**
   * Remove everything stored for a run: its events, its spilled payloads and
   * its summary.
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
    const deleted = Boolean(await this._logs().deleteStream(runStreamName(runId)));
    if (deleted) removed.push('run-file');
    removed.push('spill');
    await this.recordRunDeleted(runId);
    return { deleted, removed };
  }

  /**
   * Retention sweep: remove every run last touched before `cutoffMs`.
   *
   * Summaries drive the pass because the append log's own sweep reports counts,
   * not ids, and the ledger's delete hooks need ids. Whatever the summaries do
   * not cover — a stream whose run was never summarized — is caught by
   * `logs.sweep()` afterwards.
   *
   * @param {number} cutoffMs - Epoch milliseconds; older runs go.
   * @returns {Promise<{removed: number, cascadeIds: string[]}>} How many runs
   *   were removed and which ids the caller must run its cascade for.
   */
  async cleanup(cutoffMs) {
    let removed = 0;
    const cascadeIds = new Set();

    // `includeAnonymous`: the listings hide anonymous runs by design, but a
    // sweep that inherited that filter would never delete their documents
    // and never run the delete cascade for them.
    for (const summary of await this._scanSummaries({ includeAnonymous: true })) {
      const touched = Date.parse(summary.endedAt || summary.updatedAt || summary.startedAt || '');
      if (!Number.isFinite(touched) || touched >= cutoffMs) continue;
      if (!sweepableByAge(summary)) continue;
      await this.deleteRun(summary.runId);
      cascadeIds.add(summary.runId);
      removed += 1;
    }

    // Scoped to this ledger's own streams. The sweep is driven from
    // `runLog.retentionDays`, which is a policy about runs — store-wide, it
    // would delete any other consumer's streams on that policy.
    const swept = await this._logs().sweep({ olderThan: cutoffMs, kind: RUN_STREAM_KIND });
    removed += swept?.streams || 0;

    return { removed, cascadeIds: [...cascadeIds] };
  }

  // ── locking ────────────────────────────────────────────────────────────

  /**
   * Run `fn` while holding the run's recovery lock.
   *
   * A provider lock rejects with {@link LockTimeoutError} when the lease could
   * not be taken. Refusing to append an answer because a peer is slow would
   * lose the event, so a timeout is downgraded to a warning and `fn` runs
   * without the lock.
   *
   * @param {string} runId - Run id.
   * @param {() => Promise<T>|T} fn - The critical section.
   * @returns {Promise<T>} Whatever `fn` returned.
   * @template T
   */
  async withRunLock(runId, fn) {
    try {
      return await this._locks().withLock(runLockName(runId), fn, RUN_LOCK_OPTIONS);
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
   * Drain everything this store has buffered: the queued summary writes and the
   * provider's append log.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    // Snapshot the chain: writes queued while we wait belong to the next flush,
    // and awaiting a growing chain would never settle under a steady load.
    const queued = this._summaryWrites;
    await queued;
    await this._logs().flush();
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
   *   Narrowing hints. `includeAnonymous` is for the retention sweep only.
   * @returns {Promise<Object[]>} The summaries, newest first.
   * @private
   */
  async _scanSummaries({ kind, principalId, includeAnonymous = false }) {
    const summaries = this._summaries();
    const page = principalId
      ? await summaries.listByOwner(principalId, { kind, archived: 'all' })
      : await summaries.listAll({ includeAnonymous });
    return page?.items || [];
  }
}

export default RunLedgerStore;
