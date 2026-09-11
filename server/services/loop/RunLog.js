/**
 * RunLog — the append-only ledger underneath every run (concept §5.4).
 *
 * Two layers:
 *   1. In-memory event stream — `append()` always assigns a per-run sequence
 *      number and notifies subscribers synchronously. SSE v2 projections and
 *      tests build on this and work whether or not persistence is on.
 *   2. Persistence — only when `features.runLog` is enabled (ships dark) and
 *      `platform.runLog.enabled !== false`.
 *
 * Everything in the second layer lives in {@link RunLedgerStore}: one run's
 * events are an append-log stream, large payloads are blobs beside it, and run
 * summaries are owner-indexed documents in the `runs` namespace. When no
 * storage provider is available the store keeps writing the layout every
 * installation already has (`runs/<runId>.jsonl`, `spill/<runId>/`,
 * `index/<YYYY-MM-DD>.jsonl`), and it reads that layout either way so runs
 * written before the move stay readable. Anonymous runs are recorded with
 * `anonymous: true` and are never returned by `listRuns()`.
 *
 * Deleting a run (`deleteRun`) removes everything stored for it — events,
 * spilled payloads, summary — and runs any registered cascade hooks (e.g.
 * pending interactions).
 *
 * Sequence ownership in a cluster: the worker that started (or resumed) a run
 * owns its sequence and announces that on the cluster bus. An append made on
 * another worker on behalf of a request (`appendRecovered`: answers, human
 * events) is routed to the owner; when no worker owns the run any more the
 * recovering worker continues from the persisted ledger under a per-run lock,
 * so two recovering workers never allocate the same sequence number.
 *
 * @module services/loop/RunLog
 */
import crypto from 'crypto';
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isChatPersistenceConfigured } from '../chat/chatPersistence.js';
import logger from '../../utils/logger.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { parseRunLogEventData } from './contracts/runLogEvents.js';
import { resolvePrincipal, isAnonymousUser } from './runIdentity.js';
import {
  request as busRequest,
  respond as busRespond,
  hasRemote as busHasRemote,
  createPresenceMap
} from '../../clusterBus.js';
import { RunLedgerStore } from './runLedgerStore.js';
import { isValidId } from '../../utils/pathSecurity.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
/** Cluster bus channel on which the owner of a run appends on behalf of other workers. */
export const RUNLOG_APPEND_CHANNEL = 'runlog:append';
/** Cluster bus channel on which the owner of a run describes it to other workers. */
export const RUNLOG_META_CHANNEL = 'runlog:meta';
/** Presence kind announcing which worker owns (allocates the sequence of) a run. */
export const RUN_PRESENCE_KIND = 'run';
const REMOTE_APPEND_TIMEOUT_MS = 2000;

/**
 * Whether `runId` is acceptable as a ledger run id: the same rule as every
 * other id that becomes a file name (`pathSecurity.isValidId`).
 */
export function isValidRunId(runId) {
  return isValidId(runId);
}

function assertRunId(runId) {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid runId: ${String(runId).slice(0, 64)}`);
  }
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

export function newRunId(kind = 'run') {
  const prefix = String(kind || 'run').replace(/[^a-z]/gi, '') || 'run';
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Stable hash helper exposed for LLMClient's request/header dedupe. */
export function hashPayload(value) {
  return sha256(value);
}

export class RunLog {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseDir] - override data dir (tests)
   * @param {() => Object} [opts.getPlatformConfig] - override platform config lookup
   * @param {() => Object} [opts.getFeatures] - override feature flags lookup
   * @param {boolean} [opts.forceEnabled] - bypass the feature flag (tests)
   * @param {{request: Function, respond: Function, hasRemote: Function, createPresenceMap: Function}} [opts.bus]
   *   cluster bus (default: clusterBus) — tests inject a fake to simulate workers
   * @param {Object} [opts.logs] - append-log facet, overriding the storage provider's
   * @param {Object} [opts.documents] - document facet backing the `runs` namespace
   * @param {Object} [opts.locks] - lock facet, overriding the storage provider's
   * @param {Object} [opts.runSummaries] - ready-made run summary repository
   * @param {RunLedgerStore} [opts.store] - the persistence half, fully assembled
   */
  constructor(opts = {}) {
    this._getPlatform = opts.getPlatformConfig || (() => configCache.getPlatform?.() || {});
    this._getFeatures = opts.getFeatures || (() => configCache.getFeatures?.() || {});
    this._forceEnabled = opts.forceEnabled ?? null;
    /** @type {Map<string, {seq:number, kind:string, anonymous:boolean, principalId:string, startedAt:string, refs:Object, listeners:Set<Function>, ended:boolean, owned:boolean}>} */
    this._runs = new Map();
    this._globalListeners = new Set();
    this._deleteHooks = new Set();
    this._cleanupTimer = null;
    this._bus = opts.bus || {
      request: busRequest,
      respond: busRespond,
      hasRemote: busHasRemote,
      createPresenceMap
    };
    /** Runs whose sequence this worker allocates, announced to the other workers. */
    this._owned = this._bus.createPresenceMap(RUN_PRESENCE_KIND);
    this._unrespond = this._bus.respond(RUNLOG_APPEND_CHANNEL, payload =>
      this._appendForRemote(payload)
    );
    this._unrespondMeta = this._bus.respond(RUNLOG_META_CHANNEL, payload =>
      this._metaForRemote(payload)
    );

    this._store =
      opts.store ||
      new RunLedgerStore({
        baseDir: opts.baseDir,
        flushIntervalMs: this._runLogConfig().flushIntervalMs,
        logs: opts.logs,
        documents: opts.documents,
        locks: opts.locks,
        runSummaries: opts.runSummaries
      });
  }

  // ── configuration ──────────────────────────────────────────────────────

  _runLogConfig() {
    try {
      return this._getPlatform()?.runLog || {};
    } catch {
      return {};
    }
  }

  /**
   * Whether events are persisted to disk. In-memory emission always works.
   *
   * Durable chats are materialized from a run's own ledger events, so chat
   * persistence being configured turns the ledger on regardless of the
   * `runLog` flag — a chat store with no ledger to read back would silently
   * record nothing. `_forceEnabled` still overrides both.
   */
  isEnabled() {
    if (this._forceEnabled !== null) return this._forceEnabled;
    try {
      const features = this._getFeatures();
      if (isFeatureEnabled('runLog', features) && this._runLogConfig().enabled !== false) {
        return true;
      }
      return isChatPersistenceConfigured(features, this._getPlatform());
    } catch {
      return false;
    }
  }

  identityMode() {
    return this._runLogConfig().identityMode || 'default';
  }

  spillThresholdBytes() {
    const v = Number(this._runLogConfig().spillThresholdBytes);
    return Number.isFinite(v) && v > 0 ? v : 64 * 1024;
  }

  /**
   * The ledger's own directory. `InteractionService` keeps its store beside
   * it, so this stays the ledger's identity on disk even when events are
   * persisted through a storage provider.
   * @returns {string}
   */
  get baseDir() {
    return this._store.baseDir;
  }

  /**
   * Path of a run's event file in the ledger directory.
   * @param {string} runId
   * @returns {string}
   */
  runFilePath(runId) {
    return this._store.runFilePath(runId);
  }

  /**
   * Path of a run's spill directory in the ledger directory.
   * @param {string} runId
   * @returns {string}
   */
  spillDir(runId) {
    return this._store.spillDir(runId);
  }

  // ── run lifecycle ──────────────────────────────────────────────────────

  /**
   * Start a run: resolves the ledger principal from `user` and appends run/start.
   *
   * @param {Object} params
   * @param {string} [params.runId] - existing id to adopt (e.g. chatId-derived); generated when absent
   * @param {string} params.kind - chat|workflow|agent|subagent|inference|utility|diagnostic
   * @param {Object|null} [params.user] - req.user-like object
   * @param {Object} [params.principal] - pre-resolved principal (skips identity resolution)
   * @param {string} [params.parentRunId]
   * @param {Object} [params.trigger]
   * @param {Object} [params.refs]
   * @param {string} [params.model]
   * @param {string} [params.language]
   * @param {Object} [params.policies]
   * @returns {Promise<{runId:string, principal:Object, anonymous:boolean}>}
   */
  async startRun(params) {
    const {
      kind,
      user = null,
      parentRunId,
      trigger,
      refs = {},
      model,
      language,
      policies
    } = params;
    const principal =
      params.principal || (await resolvePrincipal(user, { mode: this.identityMode() }));
    const anonymous = principal.anonymous === true || (isAnonymousUser(user) && !params.principal);
    let runId = params.runId;
    if (runId) {
      assertRunId(runId);
    } else {
      runId = anonymous ? principal.id : newRunId(kind);
    }
    if (this._runs.has(runId) && !this._runs.get(runId).ended) {
      // Adopting an already-started run (e.g. multi-turn chat on one runId) — no new run/start.
      return { runId, principal, anonymous };
    }
    const startedAt = new Date().toISOString();
    this._register(runId, {
      seq: this._runs.get(runId)?.seq || 0,
      kind,
      anonymous,
      principalId: principal.id,
      identityMode: principal.mode || this.identityMode(),
      startedAt,
      refs,
      trigger: trigger || null,
      listeners: this._runs.get(runId)?.listeners || new Set(),
      ended: false,
      owned: true
    });
    this.append(runId, RUN_LOG_EVENTS.RUN_START, {
      kind,
      parentRunId,
      principal,
      trigger,
      refs,
      model,
      language,
      policies
    });
    if (this.isEnabled()) {
      this._store.recordRunStart({
        runId,
        kind,
        principalId: principal.id,
        identityMode: principal.mode || this.identityMode(),
        anonymous,
        parentRunId: parentRunId || null,
        refs,
        model,
        startedAt
      });
    }
    return { runId, principal, anonymous };
  }

  /**
   * Adopt a run that is not in memory (after a restart, or on the worker that
   * resumes a paused execution): this worker becomes the owner of its sequence,
   * recovered from disk when persisted.
   */
  async resumeRun(runId, { kind = 'chat', anonymous = false } = {}) {
    assertRunId(runId);
    const existing = this._runs.get(runId);
    if (existing) {
      if (!existing.owned) {
        // Taking ownership of a run this worker had only ever recovered into.
        // Its in-memory seq is whatever THIS worker last allocated, and a
        // sibling recovering the same run concurrently may have advanced the
        // ledger past it (each `appendRecovered` takes the lock in turn, so
        // the loser's entry is left behind). Re-read the persisted ledger
        // before claiming ownership, or the resumed owner re-allocates a
        // sequence another worker already wrote and the append-only ledger
        // ends up with two events sharing a seq.
        await this._syncSeqFromDisk(runId, existing);
        existing.owned = true;
        this._owned.set(runId, true);
      }
      return existing;
    }
    const seq = await this.lastSeq(runId);
    return this._register(runId, this._newEntry({ seq, kind, anonymous, owned: true }));
  }

  /**
   * Advance `entry.seq` to the persisted ledger's last sequence, under the
   * per-run lock so a concurrent `appendRecovered` cannot interleave, and
   * after a flush so unwritten events of this worker are on disk first.
   *
   * @param {string} runId
   * @param {{seq:number}} entry - in-memory run entry, mutated in place
   * @private
   */
  async _syncSeqFromDisk(runId, entry) {
    if (!this.isEnabled()) return;
    await this._store.withRunLock(runId, async () => {
      await this.flush();
      const persisted = await this._diskLastSeq(runId);
      if (persisted > entry.seq) entry.seq = persisted;
    });
  }

  /**
   * Append to a run this worker may not own (started on another worker, or
   * before a restart). Use this for appends made on behalf of a request
   * (answers, human events); `append` is for the worker that owns the run.
   *
   *  1. Owned here → plain `append`.
   *  2. Owned by another worker (cluster presence) → the owner appends and
   *     replies with the event, so one process allocates the sequence.
   *  3. No owner → continue from the persisted ledger under a per-run lock
   *     file: recovering workers take turns, and each flushes before releasing,
   *     so the next one reads a complete file.
   *
   * @param {string} runId
   * @param {string} type
   * @param {Object} data
   * @param {Object} [opts]
   * @param {string} [opts.kind='chat'] - run kind when the run has to be re-registered
   * @returns {Promise<{seq:number, ts:string, runId:string, type:string, data:Object}|null>}
   */
  async appendRecovered(runId, type, data, { kind = 'chat' } = {}) {
    assertRunId(runId);
    if (this._runs.get(runId)?.owned) return this.append(runId, type, data);

    if (this._bus.hasRemote(RUN_PRESENCE_KIND, runId)) {
      const reply = await this._bus.request(
        RUNLOG_APPEND_CHANNEL,
        { runId, type, data },
        { route: { kind: RUN_PRESENCE_KIND, key: runId }, timeoutMs: REMOTE_APPEND_TIMEOUT_MS }
      );
      if (reply && typeof reply === 'object') {
        if (reply.error) throw new Error(reply.error);
        if ('event' in reply) return reply.event;
      }
      // The owner did not answer (gone, or the presence entry is stale):
      // recover from disk below.
      logger.warn('RunLog: run owner did not answer; recovering the sequence from disk', {
        component: 'RunLog',
        runId,
        type
      });
    }

    if (!this.isEnabled()) {
      if (!this._runs.has(runId)) this._register(runId, this._newEntry({ kind, owned: false }));
      return this.append(runId, type, data);
    }

    return this._store.withRunLock(runId, async () => {
      await this.flush();
      const persisted = await this._diskLastSeq(runId);
      const entry =
        this._runs.get(runId) || this._register(runId, this._newEntry({ kind, owned: false }));
      if (persisted > entry.seq) entry.seq = persisted;
      const event = this.append(runId, type, data);
      await this.flush();
      return event;
    });
  }

  /**
   * Answer another worker's `appendRecovered` for a run this worker owns.
   * Silent (`undefined`) for runs not owned here, so the requester falls back.
   * @private
   */
  _appendForRemote(payload) {
    const runId = payload?.runId;
    if (typeof runId !== 'string' || !this._runs.get(runId)?.owned) return undefined;
    try {
      return { event: this.append(runId, payload.type, payload.data) };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Answer another worker's `resolveRunMeta` for a run this worker owns.
   * Silent (`undefined`) for runs not owned here.
   * @private
   */
  _metaForRemote(payload) {
    const runId = payload?.runId;
    if (typeof runId !== 'string' || !this._runs.get(runId)?.owned) return undefined;
    return { meta: this.getRunMeta(runId) };
  }

  /**
   * Run metadata from this worker's memory, or from the worker that owns the
   * run when this one has never seen it — a chat run with persistence off
   * lives only in the memory of the worker that started it, and the request
   * that reads or acts on it may land anywhere in the cluster.
   *
   * @param {string} runId
   * @returns {Promise<Object|null>} see `getRunMeta` (`owned: false` for a remote run)
   */
  async resolveRunMeta(runId) {
    const local = this.getRunMeta(runId);
    if (local) return local;
    if (!isValidRunId(runId) || !this._bus.hasRemote(RUN_PRESENCE_KIND, runId)) return null;
    try {
      const reply = await this._bus.request(
        RUNLOG_META_CHANNEL,
        { runId },
        { route: { kind: RUN_PRESENCE_KIND, key: runId }, timeoutMs: REMOTE_APPEND_TIMEOUT_MS }
      );
      const meta = reply && typeof reply === 'object' ? reply.meta : null;
      return meta ? { ...meta, owned: false } : null;
    } catch (err) {
      logger.warn('RunLog: run owner did not describe the run', {
        component: 'RunLog',
        runId,
        error: err.message
      });
      return null;
    }
  }

  _newEntry({ seq = 0, kind = 'chat', anonymous = false, owned = false } = {}) {
    return {
      seq,
      kind,
      anonymous,
      principalId: null,
      startedAt: null,
      refs: {},
      listeners: new Set(),
      ended: false,
      owned
    };
  }

  /** Put a run entry in memory and announce ownership when this worker allocates its sequence. */
  _register(runId, entry) {
    this._runs.set(runId, entry);
    if (entry.owned) this._owned.set(runId, true);
    else this._owned.delete(runId);
    return entry;
  }

  /** Forget a run entry (and withdraw the ownership announcement). */
  _drop(runId) {
    this._runs.delete(runId);
    this._owned.delete(runId);
  }

  /** Highest persisted seq for a run (0 when persistence is off or it has none). */
  async _diskLastSeq(runId) {
    if (!this.isEnabled()) return 0;
    return this._store.lastSeq(runId);
  }

  /**
   * Append an event. Validates `data` against the contract, assigns seq/ts,
   * notifies subscribers synchronously, and persists when enabled.
   *
   * @returns {{seq:number, ts:string, runId:string, type:string, data:Object}}
   */
  append(runId, type, data) {
    assertRunId(runId);
    let entry = this._runs.get(runId);
    if (!entry && !this.isEnabled() && this._globalListeners.size === 0) {
      // Ledger off and nobody listening: don't accumulate in-memory run entries
      // for runs that were never started here (e.g. workflow executions) — and
      // don't pay for validating an event nobody will see.
      return null;
    }
    if (type === RUN_LOG_EVENTS.RUN_END && entry?.ended) {
      // A run ends once; a second run/end (settling a paused chat run twice,
      // a relayed cancel racing the owner) is a no-op.
      return null;
    }
    const parsed = parseRunLogEventData(type, data ?? {});
    if (!entry) {
      // Unknown run (no startRun/resumeRun) — register lazily so we never lose
      // an event, but flag it: seq continuity after a restart requires resumeRun().
      logger.debug('RunLog append on unregistered run — registering lazily', {
        component: 'RunLog',
        runId,
        type
      });
      entry = this._register(runId, this._newEntry({ owned: true }));
    }
    entry.seq += 1;
    const event = { seq: entry.seq, ts: new Date().toISOString(), runId, type, data: parsed };
    if (type === RUN_LOG_EVENTS.RUN_END) entry.ended = true;

    for (const fn of entry.listeners) {
      try {
        fn(event);
      } catch (err) {
        logger.warn('RunLog listener threw', { component: 'RunLog', runId, error: err.message });
      }
    }
    for (const fn of this._globalListeners) {
      try {
        fn(event);
      } catch (err) {
        logger.warn('RunLog global listener threw', { component: 'RunLog', error: err.message });
      }
    }

    if (this.isEnabled()) {
      // Fire-and-forget by design (see runLedgerStore): the persistence layer
      // accepts the event before it does any I/O, so this stays synchronous
      // and the queue order still matches the sequence order.
      this._store.appendEvent(runId, event);
      if (type === RUN_LOG_EVENTS.RUN_END) {
        this._store.recordRunEnd({
          runId,
          kind: entry.kind,
          principalId: entry.principalId,
          anonymous: entry.anonymous,
          status: parsed.status,
          finishReason: parsed.finishReason ?? null,
          usage: parsed.usage,
          endedAt: event.ts
        });
      }
    }
    if (type === RUN_LOG_EVENTS.RUN_END) {
      // Keep a short grace window so late subscribers / projections can still
      // read the final seq; then drop the in-memory entry.
      const timer = setTimeout(() => {
        const cur = this._runs.get(runId);
        if (cur && cur.ended && cur.listeners.size === 0) this._drop(runId);
      }, 60_000);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return event;
  }

  /** Convenience: append run/end. */
  endRun(runId, { status = 'completed', finishReason = null, usage, error, durationMs } = {}) {
    return this.append(runId, RUN_LOG_EVENTS.RUN_END, {
      status,
      finishReason,
      usage,
      error,
      durationMs
    });
  }

  hasRun(runId) {
    return this._runs.has(runId);
  }

  /**
   * Whether an event appended to `runId` would be seen by anyone (persisted
   * or delivered to a subscriber). Callers use it to skip building payloads —
   * hashing a whole context per step — on installs with the ledger off.
   */
  isRecording(runId) {
    if (this.isEnabled() || this._globalListeners.size > 0) return true;
    return (this._runs.get(runId)?.listeners.size || 0) > 0;
  }

  /**
   * Whether the run has recorded `run/end`: memory first, then the last
   * persisted event (a tail read, not the whole file).
   */
  async hasEnded(runId) {
    const meta = this._runs.get(runId);
    if (meta) return meta.ended === true;
    if (!this.isEnabled()) return false;
    const last = await this._store.lastEvent(runId);
    return last?.type === RUN_LOG_EVENTS.RUN_END;
  }

  getRunMeta(runId) {
    const e = this._runs.get(runId);
    if (!e) return null;
    return {
      runId,
      kind: e.kind,
      anonymous: e.anonymous,
      principalId: e.principalId,
      startedAt: e.startedAt,
      refs: e.refs,
      trigger: e.trigger || null,
      /** Identity mode the principal was recorded in (owner checks must resolve the caller the same way). */
      identityMode: e.identityMode || null,
      seq: e.seq,
      ended: e.ended,
      /** Whether this worker allocates the run's sequence. */
      owned: e.owned === true
    };
  }

  /** Current in-memory seq (0 when unknown). Use lastSeq() to include disk. */
  currentSeq(runId) {
    return this._runs.get(runId)?.seq || 0;
  }

  // ── subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to a run's events (synchronous callbacks). Returns unsubscribe.
   */
  subscribe(runId, fn) {
    assertRunId(runId);
    let entry = this._runs.get(runId);
    if (!entry) entry = this._register(runId, this._newEntry({ owned: false }));
    entry.listeners.add(fn);
    return () => {
      const cur = this._runs.get(runId);
      if (cur) {
        cur.listeners.delete(fn);
        if (cur.ended && cur.listeners.size === 0) this._drop(runId);
      }
    };
  }

  subscribeAll(fn) {
    this._globalListeners.add(fn);
    return () => this._globalListeners.delete(fn);
  }

  /**
   * Register a cascade hook invoked on `deleteRun(runId)`.
   *
   * `batched` changes the call shape, not when it runs: the hook is handed the
   * whole array of run ids the caller is deleting, once, instead of being
   * called per id. It exists because a hook whose cascade is a namespace scan
   * costs the same whether it is looking for one run or five hundred — and the
   * retention sweep deletes them in bulk, so per-id it paid that scan five
   * hundred times over.
   *
   * @param {(runId: string|string[]) => any} fn - The hook.
   * @param {Object} [options]
   * @param {boolean} [options.batched=false] - Receive an array of ids at once.
   * @returns {() => void} Unregister.
   */
  onDelete(fn, { batched = false } = {}) {
    const entry = { fn, batched };
    this._deleteHooks.add(entry);
    return () => this._deleteHooks.delete(entry);
  }

  // ── persistence helpers ────────────────────────────────────────────────

  async flush() {
    await this._store.flush();
  }

  /**
   * Spill a large payload beside the run and return a reference.
   *
   * The reference keeps its `path` string on every backend: it is validated by
   * `spillRefSchema`, copied into the tool message the model reads, and hashed
   * into `request/header.messagesHash`.
   *
   * @param {string} runId
   * @param {string} name - name for the payload; sanitized
   * @param {string|Object} content - serialized when it is not already a string
   * @param {string} [contentType='application/json']
   * @returns {Promise<{path:string, bytes:number, sha256:string, contentType?:string}|null>}
   */
  async spill(runId, name, content, contentType = 'application/json') {
    if (!this.isEnabled()) return null;
    assertRunId(runId);
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    return this._store.putSpill(runId, name, body, contentType);
  }

  /**
   * Read a spilled payload back as text.
   * @param {string} runId
   * @param {{path?:string}} ref - reference taken off a ledger event
   * @returns {Promise<string>}
   */
  async readSpill(runId, ref) {
    assertRunId(runId);
    return this._store.readSpill(runId, ref);
  }

  /**
   * Read a run's persisted events. Returns [] when persistence is off or the
   * run has none.
   * @param {string} runId
   * @param {{afterSeq?:number, limit?:number}} [opts]
   */
  async readEvents(runId, { afterSeq = 0, limit = Infinity } = {}) {
    if (!this.isEnabled()) return [];
    assertRunId(runId);
    return this._store.readEvents(runId, { afterSeq, limit });
  }

  /** Highest seq known for a run (memory first, then the last persisted event). */
  async lastSeq(runId) {
    const mem = this._runs.get(runId)?.seq;
    if (mem) return mem;
    if (!this.isEnabled()) return 0;
    return this._store.lastSeq(runId);
  }

  /**
   * The run's `run/start` event as persisted, without reading the rest of it.
   * `null` when persistence is off or the run has none.
   * @param {string} runId
   * @returns {Promise<Object|null>}
   */
  async readStart(runId) {
    if (!this.isEnabled()) return null;
    assertRunId(runId);
    return this._store.readStart(runId);
  }

  /**
   * List runs, newest first. Anonymous runs are never listed.
   *
   * The `runs` namespace is the index; runs that predate it are still read out
   * of the legacy per-day index files.
   *
   * @param {{from?:string|Date, to?:string|Date, kind?:string, principalId?:string, limit?:number}} [opts]
   * @returns {Promise<Object[]>}
   */
  async listRuns({ from, to, kind, principalId, limit = 100 } = {}) {
    if (!this.isEnabled()) return [];
    await this.flush();
    return this._store.listRuns({ from, to, kind, principalId, limit });
  }

  /**
   * Delete a run with cascade: its events, its spilled payloads, its summary,
   * and any registered cascade hooks.
   * @param {string} runId
   * @returns {Promise<{runId:string, deleted:boolean, cascaded:string[]}>}
   */
  async deleteRun(runId) {
    assertRunId(runId);
    const cascaded = await this._cascadeDelete(runId);
    if (!this.isEnabled()) return { runId, deleted: false, cascaded };
    const { removed } = await this._store.deleteRun(runId);
    cascaded.push(...removed);
    return { runId, deleted: true, cascaded };
  }

  /**
   * Run the delete cascade for a run: every registered hook (pending
   * interactions, …) and this worker's in-memory entry. Shared by `deleteRun`
   * and the retention sweep so both remove the same things.
   * @returns {Promise<string[]>} what the hooks reported as cascaded
   * @private
   */
  async _cascadeDelete(runId) {
    return this._cascadeDeleteMany([runId]);
  }

  /**
   * The same cascade for a whole set of runs, with each batched hook called
   * once. The retention sweep uses it: a hook whose cascade is a namespace
   * scan costs the same for five hundred runs as for one, and per-id it paid
   * that cost five hundred times.
   *
   * @param {string[]} runIds - Runs being deleted.
   * @returns {Promise<string[]>} what the hooks reported as cascaded
   * @private
   */
  async _cascadeDeleteMany(runIds) {
    const cascaded = [];
    if (runIds.length === 0) return cascaded;
    for (const { fn, batched } of this._deleteHooks) {
      const calls = batched ? [runIds] : runIds.map(id => id);
      for (const arg of calls) {
        try {
          const res = await fn(arg);
          if (res) cascaded.push(typeof res === 'string' ? res : 'hook');
        } catch (err) {
          logger.warn('RunLog delete hook failed', {
            component: 'RunLog',
            runId: Array.isArray(arg) ? `${arg.length} runs` : arg,
            error: err.message
          });
        }
      }
    }
    for (const runId of runIds) this._drop(runId);
    return cascaded;
  }

  /**
   * Remove runs older than `retentionDays`: their events, their spilled
   * payloads, their summary, and the same cascade `deleteRun` performs
   * (delete hooks, e.g. the run's interactions). Legacy index files older
   * than the cutoff are removed as well.
   *
   * @param {number} retentionDays - days to keep; `<= 0` disables the sweep
   * @returns {Promise<{removed:number}>}
   */
  async cleanup(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { removed: 0 };
    if (!this.isEnabled()) return { removed: 0 };
    const cutoff = Date.now() - retentionDays * DAY_MS;
    const { removed, cascadeIds } = await this._store.cleanup(cutoff);
    // One cascade for the whole sweep rather than one per run: a batched hook
    // sees every id at once and pays its namespace scan once.
    await this._cascadeDeleteMany(cascadeIds.filter(runId => isValidRunId(runId)));
    if (removed > 0) logger.info('RunLog retention cleanup', { component: 'RunLog', removed });
    return { removed };
  }

  startCleanupScheduler() {
    if (this._cleanupTimer) return;
    const run = () => {
      const cfg = this._runLogConfig();
      const enabled = cfg.cleanupEnabled !== false;
      const days = Number.isFinite(cfg.retentionDays) ? cfg.retentionDays : DEFAULT_RETENTION_DAYS;
      if (!enabled) return;
      this.cleanup(days).catch(err =>
        logger.error('RunLog cleanup failed', { component: 'RunLog', error: err.message })
      );
    };
    run();
    this._cleanupTimer = setInterval(run, DAY_MS);
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
  }

  async stop() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
    this._unrespond?.();
    this._unrespond = null;
    this._unrespondMeta?.();
    this._unrespondMeta = null;
    this._owned.clear();
    this._store.stop();
    await this.flush();
  }
}

/** Process-wide default instance. */
const runLog = new RunLog();
export default runLog;
