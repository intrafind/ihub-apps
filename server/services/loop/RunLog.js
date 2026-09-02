/**
 * RunLog — the append-only ledger underneath every run (concept §5.4).
 *
 * One JSONL file per run under `contents/data/run-log/runs/<runId>.jsonl`,
 * written through the shared buffered JSONL appender (the AuditLogService
 * pattern): batched appends, periodic flush, drop-oldest overflow cap, and a
 * write lock that serializes flushes against retention cleanup. Large payloads
 * are spilled to `spill/<runId>/` and referenced from the line. A per-day
 * index (`index/<YYYY-MM-DD>.jsonl`) carries run/start + run/end summaries for
 * listing; anonymous runs are indexed with `anonymous: true` and are never
 * returned by `listRuns()`.
 *
 * Two layers:
 *   1. In-memory event stream — `append()` always assigns a per-run sequence
 *      number and notifies subscribers synchronously. SSE v2 projections and
 *      tests build on this and work whether or not persistence is on.
 *   2. Persistence — only when `features.runLog` is enabled (ships dark) and
 *      `platform.runLog.enabled !== false`.
 *
 * Deleting a run (`deleteRun`) is a file delete with cascade: run file, spill
 * dir, index tombstone, and any registered cascade hooks (e.g. pending
 * interactions).
 *
 * Sequence ownership in a cluster: the worker that started (or resumed) a run
 * owns its sequence and announces that on the cluster bus. An append made on
 * another worker on behalf of a request (`appendRecovered`: answers, human
 * events) is routed to the owner; when no worker owns the run any more the
 * recovering worker continues from the persisted ledger under a per-run lock
 * file, so two recovering workers never allocate the same sequence number.
 *
 * @module services/loop/RunLog
 */
import { promises as fs, createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import crypto from 'crypto';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import { createJsonlAppender } from '../../utils/jsonlAppender.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { parseRunLogEventData } from './contracts/runLogEvents.js';
import { resolvePrincipal, isAnonymousUser } from './runIdentity.js';
import {
  request as busRequest,
  respond as busRespond,
  hasRemote as busHasRemote,
  createPresenceMap
} from '../../clusterBus.js';
import { withFileLock } from '../../utils/fileLock.js';
import { isValidId } from '../../utils/pathSecurity.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_FLUSH_MS = 2000;
const MAX_QUEUE = 20000;
/** Cluster bus channel on which the owner of a run appends on behalf of other workers. */
export const RUNLOG_APPEND_CHANNEL = 'runlog:append';
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

/**
 * Validate an id and reduce it to a single path segment. `path.basename` is
 * the sanitizer static analysis recognizes; `assertRunId` already rejects
 * separators and dots, so for valid ids this is the identity.
 * @param {string} id
 * @returns {string}
 */
function safeSegment(id) {
  assertRunId(id);
  return path.basename(String(id));
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
   */
  constructor(opts = {}) {
    this._baseDir =
      opts.baseDir || path.join(getRootDir(), config.CONTENTS_DIR, config.DATA_DIR, 'run-log');
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

    const flushIntervalMs = Number(this._runLogConfig().flushIntervalMs) || DEFAULT_FLUSH_MS;
    this._appender = createJsonlAppender({
      getFilePath: entry => this.runFilePath(entry.runId),
      flushIntervalMs,
      maxQueueSize: MAX_QUEUE,
      component: 'RunLog'
    });
    this._indexAppender = createJsonlAppender({
      getFilePath: entry => path.join(this._baseDir, 'index', `${entry.ts.slice(0, 10)}.jsonl`),
      flushIntervalMs,
      maxQueueSize: MAX_QUEUE,
      component: 'RunLogIndex'
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

  /** Whether events are persisted to disk. In-memory emission always works. */
  isEnabled() {
    if (this._forceEnabled !== null) return this._forceEnabled;
    try {
      if (!isFeatureEnabled('runLog', this._getFeatures())) return false;
    } catch {
      return false;
    }
    return this._runLogConfig().enabled !== false;
  }

  identityMode() {
    return this._runLogConfig().identityMode || 'default';
  }

  spillThresholdBytes() {
    const v = Number(this._runLogConfig().spillThresholdBytes);
    return Number.isFinite(v) && v > 0 ? v : 64 * 1024;
  }

  get baseDir() {
    return this._baseDir;
  }

  runFilePath(runId) {
    return this._containedPath('runs', `${safeSegment(runId)}.jsonl`);
  }

  spillDir(runId) {
    return this._containedPath('spill', safeSegment(runId));
  }

  /**
   * Join `segments` under the ledger base dir and refuse anything that would
   * resolve outside it (defense in depth on top of `assertRunId`).
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
      this._indexAppender.append({
        ts: startedAt,
        runId,
        kind,
        principalId: principal.id,
        anonymous,
        parentRunId: parentRunId || null,
        refs,
        status: 'running'
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
        existing.owned = true;
        this._owned.set(runId, true);
      }
      return existing;
    }
    const seq = await this.lastSeq(runId);
    return this._register(runId, this._newEntry({ seq, kind, anonymous, owned: true }));
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

    return withFileLock(
      this._lockPath(runId),
      async () => {
        await this.flush();
        const persisted = await this._diskLastSeq(runId);
        const entry =
          this._runs.get(runId) || this._register(runId, this._newEntry({ kind, owned: false }));
        if (persisted > entry.seq) entry.seq = persisted;
        const event = this.append(runId, type, data);
        await this.flush();
        return event;
      },
      { component: 'RunLog' }
    );
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

  _lockPath(runId) {
    return this._containedPath('locks', `${safeSegment(runId)}.lock`);
  }

  /** Highest seq on disk for a run (0 when persistence is off or the run has no file). */
  async _diskLastSeq(runId) {
    if (!this.isEnabled()) return 0;
    return (await this._diskLastEvent(runId))?.seq || 0;
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
      this._appender.append(event);
      if (type === RUN_LOG_EVENTS.RUN_END) {
        this._indexAppender.append({
          ts: event.ts,
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
    const last = await this._diskLastEvent(runId);
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

  /** Register a cascade hook invoked on deleteRun(runId). */
  onDelete(fn) {
    this._deleteHooks.add(fn);
    return () => this._deleteHooks.delete(fn);
  }

  // ── persistence helpers ────────────────────────────────────────────────

  async flush() {
    await this._appender.flush();
    await this._indexAppender.flush();
  }

  /**
   * Spill a large payload next to the run and return a reference.
   * @returns {Promise<{path:string, bytes:number, sha256:string, contentType?:string}|null>}
   */
  async spill(runId, name, content, contentType = 'application/json') {
    if (!this.isEnabled()) return null;
    const dir = this.spillDir(runId);
    const safeName = String(name)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 120);
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    await fs.mkdir(dir, { recursive: true });
    const file = this._containedPath('spill', safeSegment(runId), path.basename(safeName));
    await fs.writeFile(file, body, 'utf8');
    return {
      path: path.relative(this._baseDir, file),
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: sha256(body),
      contentType
    };
  }

  async readSpill(runId, ref) {
    // Spill files are flat under the run's spill dir, so the reference reduces
    // to its basename; anything else is a forged reference.
    const name = path.basename(String(ref?.path || ''));
    if (!name || name === '.' || name === '..') {
      throw new Error('Invalid spill reference');
    }
    const abs = this._containedPath('spill', safeSegment(runId), name);
    return fs.readFile(abs, 'utf8');
  }

  /**
   * Read a run's events from disk (flushes first). Returns [] when persistence
   * is off or the run has no file.
   * @param {string} runId
   * @param {{afterSeq?:number, limit?:number}} [opts]
   */
  async readEvents(runId, { afterSeq = 0, limit = Infinity } = {}) {
    if (!this.isEnabled()) return [];
    // Only flush when something is buffered: a read must never cost a disk
    // write when the appender is idle.
    if (this._appender.queueLength() > 0) await this.flush();
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
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.seq > afterSeq) {
        out.push(evt);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Highest seq known for a run (memory first, then the last persisted line). */
  async lastSeq(runId) {
    const mem = this._runs.get(runId)?.seq;
    if (mem) return mem;
    if (!this.isEnabled()) return 0;
    return (await this._diskLastEvent(runId))?.seq || 0;
  }

  /**
   * The run's `run/start` event from disk (the first line), without flushing
   * or reading the rest of the file. `null` when persistence is off or the
   * run has no file.
   */
  async readStart(runId) {
    if (!this.isEnabled()) return null;
    const file = this.runFilePath(runId);
    let first = await this._readFirstLine(file);
    if (first === null && this._appender.queueLength() > 0) {
      // The start may still sit in the buffer.
      await this.flush();
      first = await this._readFirstLine(file);
    }
    if (!first) return null;
    try {
      const evt = JSON.parse(first);
      return evt?.type === RUN_LOG_EVENTS.RUN_START ? evt : null;
    } catch {
      return null;
    }
  }

  async _readFirstLine(file) {
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
   * The last complete event on disk, read from the file's tail (the last
   * 64 KiB, growing backwards when a line is longer). Flushes first only when
   * the appender holds buffered events.
   * @private
   */
  async _diskLastEvent(runId) {
    if (this._appender.queueLength() > 0) await this.flush();
    const file = this.runFilePath(runId);
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

  /**
   * List runs from the per-day index. Anonymous runs are never listed.
   * @param {{from?:string|Date, to?:string|Date, kind?:string, principalId?:string, limit?:number}} [opts]
   */
  async listRuns({ from, to, kind, principalId, limit = 100 } = {}) {
    if (!this.isEnabled()) return [];
    await this.flush();
    const dir = path.join(this._baseDir, 'index');
    let files;
    try {
      files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const fromDay = from ? new Date(from).toISOString().slice(0, 10) : null;
    const toDay = to ? new Date(to).toISOString().slice(0, 10) : null;
    const byRun = new Map();
    const deleted = new Set();
    for (const f of files) {
      const day = f.slice(0, 10);
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
      const rl = createInterface({
        input: createReadStream(path.join(dir, f), 'utf8'),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.deleted) {
          deleted.add(e.runId);
          byRun.delete(e.runId);
          continue;
        }
        if (e.anonymous) continue;
        if (deleted.has(e.runId)) continue;
        const prev = byRun.get(e.runId) || {};
        byRun.set(e.runId, { ...prev, ...e, startedAt: prev.startedAt || e.ts });
      }
    }
    let runs = [...byRun.values()];
    if (kind) runs = runs.filter(r => r.kind === kind);
    if (principalId) runs = runs.filter(r => r.principalId === principalId);
    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return runs.slice(0, limit);
  }

  /**
   * Delete a run with cascade: run file, spill dir, index tombstone, hooks.
   * @returns {Promise<{runId:string, deleted:boolean, cascaded:string[]}>}
   */
  async deleteRun(runId) {
    assertRunId(runId);
    const cascaded = await this._cascadeDelete(runId);
    if (!this.isEnabled()) return { runId, deleted: false, cascaded };
    await this._appender.withWriteLock(async () => {
      await this._appender.drainToDisk().catch(() => {});
      let deleted = false;
      try {
        await fs.unlink(this.runFilePath(runId));
        deleted = true;
        cascaded.push('run-file');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      try {
        await fs.rm(this.spillDir(runId), { recursive: true, force: true });
        cascaded.push('spill');
      } catch {
        /* ignore */
      }
      this._indexAppender.append({ ts: new Date().toISOString(), runId, deleted: true });
      await this._indexAppender.flush();
      return deleted;
    });
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
    const cascaded = [];
    for (const hook of this._deleteHooks) {
      try {
        const res = await hook(runId);
        if (res) cascaded.push(typeof res === 'string' ? res : 'hook');
      } catch (err) {
        logger.warn('RunLog delete hook failed', {
          component: 'RunLog',
          runId,
          error: err.message
        });
      }
    }
    this._drop(runId);
    return cascaded;
  }

  /**
   * Remove runs older than `retentionDays`: run file, spill dir and the same
   * cascade `deleteRun` performs (delete hooks, e.g. the run's interactions);
   * index files older than the cutoff are removed as well.
   */
  async cleanup(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { removed: 0 };
    if (!this.isEnabled()) return { removed: 0 };
    const cutoff = Date.now() - retentionDays * DAY_MS;
    let removed = 0;
    await this._appender.withWriteLock(async () => {
      await this._appender.drainToDisk().catch(() => {});
      const runsDir = path.join(this._baseDir, 'runs');
      let files = [];
      try {
        files = await fs.readdir(runsDir);
      } catch {
        return;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const abs = path.join(runsDir, f);
        try {
          const st = await fs.stat(abs);
          if (st.mtimeMs < cutoff) {
            const runId = f.replace(/\.jsonl$/, '');
            await fs.unlink(abs);
            await fs.rm(path.join(this._baseDir, 'spill', runId), {
              recursive: true,
              force: true
            });
            if (isValidRunId(runId)) await this._cascadeDelete(runId);
            removed++;
          }
        } catch {
          /* ignore individual failures */
        }
      }
      const indexDir = path.join(this._baseDir, 'index');
      try {
        const idx = await fs.readdir(indexDir);
        const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
        for (const f of idx) {
          if (f.endsWith('.jsonl') && f.slice(0, 10) < cutoffDay) {
            await fs.unlink(path.join(indexDir, f)).catch(() => {});
          }
        }
      } catch {
        /* ignore */
      }
    });
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
    this._owned.clear();
    this._appender.stop();
    this._indexAppender.stop();
    await this.flush();
  }
}

/** Process-wide default instance. */
const runLog = new RunLog();
export default runLog;
