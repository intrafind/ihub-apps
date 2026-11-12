// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * WorkflowStateRepository — workflow execution state on the storage provider.
 *
 * Every reader of a workflow checkpoint goes through this repository: the state
 * manager's lazy read, the resume manager, the orphan sweeper and the execution
 * registry's rescan. It is the only thing that knows where a state lives: one
 * document per execution in the `workflow-state` namespace, owned by the
 * principal that started it.
 *
 * Checkpoints written by releases before the storage provider (5.5.2) as
 * `<executionId>/latest.json` directories are carried into the namespace once by
 * migration V219; nothing reads that layout any more.
 *
 * @module services/workflow/WorkflowStateRepository
 */
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { requireStorage } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';

const COMPONENT = 'WorkflowStateRepository';

/** Namespace holding one document per workflow execution state. */
export const WORKFLOW_STATE_NAMESPACE = RUNTIME_NAMESPACES.workflowState;

/**
 * Namespace of the active-execution index: one small document per execution
 * whose last stored status is not terminal, keyed by the execution id.
 */
export const WORKFLOW_ACTIVE_NAMESPACE = RUNTIME_NAMESPACES.workflowActive;

/** Namespace of the one-time markers (shared with the runtime imports). */
const MARKER_NAMESPACE = RUNTIME_NAMESPACES.runtimeImports;

/** Marker recording that the active-execution index has been built. */
export const ACTIVE_INDEX_MARKER = 'workflow-active-index';

/**
 * Statuses a run never leaves. Everything else — `running`, `pending`, and
 * `paused` for a run waiting on a person, however long ago — is unfinished and
 * kept in the active index.
 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Documents read per page while the active index is rebuilt without `scan`. */
const REBUILD_PAGE_SIZE = 10;

/**
 * Hard ceiling on how many states one scan considers.
 *
 * A scan that tried to hold an unbounded directory in memory would fail on the
 * installation that needs it most. Truncation is reported to the caller so it
 * can be logged with the context of whatever asked for the scan — a silently
 * short list reads as "that is all there is".
 */
export const MAX_SCAN_STATES = 20_000;

/** Documents fetched per `list` call while scanning the namespace. */
const SCAN_PAGE_SIZE = 200;

/**
 * Keys in this namespace that are not execution states.
 *
 * `execution-registry.json` has lived in this directory since long before it
 * became a storage namespace, and the document store would happily surface it
 * as a document called `execution-registry`. Reading it as a state is
 * harmless; *deleting* it as one would take the whole registry with it, so the
 * name is refused at every entry point rather than filtered at one.
 */
const RESERVED_KEYS = new Set(['execution-registry']);

/**
 * Whether a parsed value looks like a workflow execution state.
 *
 * Deliberately loose: the shape has grown over releases and a state written by
 * an older version must still be readable. What it rules out is the other JSON
 * that shares this directory — the execution registry, a stray file, a
 * document envelope whose body never got written.
 *
 * @param {unknown} value - Parsed JSON.
 * @returns {boolean} True when the value can be treated as a state.
 */
export function isWorkflowState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.status === 'string' || typeof value.workflowId === 'string';
}

/**
 * The principal that owns an execution, in the registry's own vocabulary.
 *
 * Agent runs are owned by their service principal (`agent:<profileId>`) and
 * plain runs by the user who started them — the same two values
 * `ExecutionRegistry` stores as `userId`, so an owner-scoped listing of states
 * and an owner-scoped listing of run summaries agree.
 *
 * @param {Object} state - Execution state.
 * @returns {string|null} Owning principal id, or null when the state predates
 *   the fields that carry it.
 */
export function workflowStateOwnerId(state) {
  const profileId = state?.data?._agent?.profileId;
  if (typeof profileId === 'string' && profileId.length > 0) return `agent:${profileId}`;
  const startedBy = state?.data?._workflow?.startedBy;
  if (typeof startedBy === 'string' && startedBy.length > 0) return startedBy;
  return null;
}

/**
 * Whether an execution id can be used as a document key and a directory name.
 *
 * @param {string} executionId - Candidate id.
 * @returns {boolean}
 */
function isStorableId(executionId) {
  // `isValidId` already rejects traversal; the explicit `..` check keeps the
  // barrier visible to static analysis at the filesystem sink.
  if (!isValidId(executionId) || executionId.includes('..')) return false;
  return !RESERVED_KEYS.has(executionId);
}

/**
 * Whether a stored status means the run is unfinished.
 *
 * @param {unknown} status - `state.status`.
 * @returns {boolean} True for any status but a terminal one; false for a
 *   state without a status, which nothing can resume or sweep either.
 */
export function isActiveStatus(status) {
  return typeof status === 'string' && status.length > 0 && !TERMINAL_STATUSES.has(status);
}

/**
 * Milliseconds since the epoch for a timestamp that may be missing or junk.
 *
 * @param {unknown} value - ISO timestamp or anything else.
 * @returns {number} Parsed time, or `NaN` when it cannot be established.
 */
function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Workflow execution state, read and written through the storage provider.
 */
export class WorkflowStateRepository {
  /**
   * @param {Object} options
   * @param {import('../../storage/DocumentStore.js').DocumentStore} options.documents
   *   Document facet of the storage provider.
   * @param {import('../../storage/LockManager.js').LockManager} [options.locks]
   *   Lock facet.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   */
  constructor({ documents, locks = null, logger: log } = {}) {
    if (!documents) {
      throw new TypeError('WorkflowStateRepository needs the provider documents facet');
    }
    this.documents = documents;
    this.locks = locks || null;
    this.logger = log || logger;

    /**
     * Status this process last recorded in the active index, per execution,
     * so a run checkpointing every node writes its index entry once per status
     * change rather than once per checkpoint. Entries leave with the run.
     * @type {Map<string, string>}
     * @private
     */
    this._indexed = new Map();

    /**
     * Tail of the pending write chain per execution, so a state and its index
     * entry are updated in the order the writes were made.
     * @type {Map<string, Promise<void>>}
     * @private
     */
    this._chains = new Map();
  }

  /**
   * Run `fn` after the writes already queued for this execution.
   *
   * @param {string} executionId - Execution identifier.
   * @param {() => Promise<T>} fn - The write.
   * @returns {Promise<T>}
   * @template T
   * @private
   */
  _serialize(executionId, fn) {
    const previous = this._chains.get(executionId) || Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this._chains.set(executionId, settled);
    void settled.then(() => {
      if (this._chains.get(executionId) === settled) this._chains.delete(executionId);
    });
    return run;
  }

  /**
   * Read one execution's state.
   *
   * An unreadable or unparseable state reads as absent, which is what every
   * caller already expected from its own `try { JSON.parse } catch { null }`.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<Object|null>} The state, or null when there is none.
   */
  async read(executionId) {
    if (!isStorableId(executionId)) {
      this.logger.warn('Invalid executionId for workflow state read', {
        component: COMPONENT,
        executionId: String(executionId).slice(0, 64)
      });
      return null;
    }
    try {
      const doc = await this.documents.get(WORKFLOW_STATE_NAMESPACE, executionId);
      return isWorkflowState(doc?.data) ? doc.data : null;
    } catch (error) {
      this.logger.warn('Could not read workflow state document', {
        component: COMPONENT,
        executionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Persist an execution's state.
   *
   * @param {string} executionId - Execution identifier.
   * @param {Object} state - The state to store.
   * @param {Object} [options]
   * @param {string|null} [options.ownerId] - Owning principal; see
   *   {@link workflowStateOwnerId}.
   * @returns {Promise<void>}
   * @throws {Error} When `executionId` cannot be used as a key.
   */
  async write(executionId, state, { ownerId = null } = {}) {
    if (!isStorableId(executionId)) {
      throw new Error(
        `Invalid executionId for workflow state: ${String(executionId).slice(0, 64)}`
      );
    }
    const status = state?.status;
    await this._serialize(executionId, async () => {
      // An unfinished run enters the index before its state is stored, and a
      // finished one leaves it only after: a crash in between leaves an entry
      // too many, which the readers prune, never a run the index cannot see.
      if (isActiveStatus(status)) await this._markActive(executionId, status);
      await this.documents.put(WORKFLOW_STATE_NAMESPACE, executionId, state, {
        ownerId: typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : null
      });
      if (!isActiveStatus(status)) await this._clearActive(executionId);
    });
  }

  /**
   * Remove an execution's state.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<boolean>} True when something was actually removed.
   */
  async remove(executionId) {
    if (!isStorableId(executionId)) {
      this.logger.warn('Invalid executionId for workflow state removal', {
        component: COMPONENT,
        executionId: String(executionId).slice(0, 64)
      });
      return false;
    }
    return this._serialize(executionId, async () => {
      let removed;
      try {
        removed = Boolean(await this.documents.delete(WORKFLOW_STATE_NAMESPACE, executionId));
      } catch (error) {
        this.logger.warn('Could not remove workflow state document', {
          component: COMPONENT,
          executionId,
          error: error.message
        });
        return false;
      }
      await this._clearActive(executionId);
      return removed;
    });
  }

  /**
   * The executions whose last stored state is unfinished, from the active
   * index — without reading or listing a single state.
   *
   * The index is built from a full walk of the states the first time it is
   * asked for on an installation (see {@link WorkflowStateRepository#ensureActiveIndex}),
   * and kept by every {@link WorkflowStateRepository#write} and
   * {@link WorkflowStateRepository#remove} after that. It is a superset, never
   * a subset: a crash between a state write and its index update leaves an
   * entry whose state is already terminal. Callers read the state of each
   * entry anyway and hand the stale ones to
   * {@link WorkflowStateRepository#forgetActive}.
   *
   * There is no age cut-off: a run paused for a person's approval stays here
   * until it finishes, however long that takes.
   *
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only ids starting with this.
   * @param {number} [options.max] - Hard record bound.
   * @returns {Promise<{items: Array<{executionId: string, status: string|null}>,
   *   truncated: boolean}>}
   */
  async listActive({ prefix = null, max = MAX_SCAN_STATES } = {}) {
    await this.ensureActiveIndex();
    const bound = Number.isFinite(max) && max > 0 ? max : MAX_SCAN_STATES;
    const items = [];
    let cursor = null;
    do {
      const page = await this.documents.list(WORKFLOW_ACTIVE_NAMESPACE, {
        limit: 1000,
        ...(prefix ? { prefix } : {}),
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        if (!isStorableId(doc.key)) continue;
        const status = typeof doc.data?.status === 'string' ? doc.data.status : null;
        items.push({ executionId: doc.key, status });
      }
      cursor = page.nextCursor;
    } while (cursor && items.length < bound);
    return { items, truncated: Boolean(cursor) };
  }

  /**
   * Check an entry of {@link WorkflowStateRepository#listActive} against the
   * state a caller has just read for it, and drop the entry when the state
   * shows the run is finished, or is gone.
   *
   * A state that is present but could not be read keeps its entry: "could
   * not read it" is not evidence that the run is finished.
   *
   * @param {string} executionId - Execution identifier.
   * @param {Object|null} state - What {@link WorkflowStateRepository#read} returned.
   * @returns {Promise<boolean>} True when the run is still unfinished.
   */
  async confirmActive(executionId, state) {
    if (state && isActiveStatus(state.status)) return true;
    if (!isStorableId(executionId)) return false;
    if (!state && (await this._stateMayExist(executionId))) return false;
    await this._serialize(executionId, () => this._clearActive(executionId));
    return false;
  }

  /**
   * Whether a state document is (or may be) stored for this execution.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<boolean>} False only when the store says it is absent.
   * @private
   */
  async _stateMayExist(executionId) {
    try {
      return Boolean(await this.documents.get(WORKFLOW_STATE_NAMESPACE, executionId));
    } catch {
      return true;
    }
  }

  /**
   * Build the active index once per installation.
   *
   * States written before the index existed — or carried in by migration
   * V219 straight into the namespace — never went through
   * {@link WorkflowStateRepository#write}, so the first listing walks every
   * state once, one document at a time, and records the unfinished ones. A
   * marker then says it is done; from there on the index is kept by the
   * writes. The walk is idempotent, so two processes racing to build it only
   * do the same work twice.
   *
   * @returns {Promise<void>}
   * @throws {Error} When the walk fails; the marker is then not written and
   *   the next call tries again.
   */
  async ensureActiveIndex() {
    if (await this.hasMarker(ACTIVE_INDEX_MARKER)) return;
    const started = Date.now();
    let scanned = 0;
    let indexed = 0;
    for await (const doc of this._walkStates()) {
      scanned += 1;
      if (RESERVED_KEYS.has(doc.key) || !isStorableId(doc.key)) continue;
      if (!isWorkflowState(doc.data) || !isActiveStatus(doc.data.status)) continue;
      await this._serialize(doc.key, () => this._markActive(doc.key, doc.data.status));
      indexed += 1;
    }
    await this.writeMarker(ACTIVE_INDEX_MARKER, { scanned, indexed });
    this.logger.info('Built the index of unfinished workflow executions', {
      component: COMPONENT,
      scanned,
      indexed,
      durationMs: Date.now() - started
    });
  }

  /**
   * Whether a one-time job has recorded itself as done.
   *
   * @param {string} name - Marker key.
   * @returns {Promise<boolean>}
   */
  async hasMarker(name) {
    const marker = await this.documents.get(MARKER_NAMESPACE, name);
    return Boolean(marker?.data?.completedAt);
  }

  /**
   * Record a one-time job as done.
   *
   * @param {string} name - Marker key.
   * @param {Object} [details] - Stored with the marker, for an operator.
   * @returns {Promise<void>}
   */
  async writeMarker(name, details = {}) {
    await this.documents.put(MARKER_NAMESPACE, name, {
      completedAt: new Date().toISOString(),
      ...details
    });
  }

  /**
   * Every stored state, one at a time, so a walk holds one state in memory
   * rather than a page of them.
   *
   * @returns {AsyncGenerator<Object>} Documents with data.
   * @private
   */
  async *_walkStates() {
    if (this.documents.supportsScan) {
      yield* this.documents.scan(WORKFLOW_STATE_NAMESPACE);
      return;
    }
    let cursor = null;
    do {
      const page = await this.documents.list(WORKFLOW_STATE_NAMESPACE, {
        limit: REBUILD_PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      });
      yield* page.items;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Record an execution as unfinished in the index.
   *
   * A failure here is logged, not thrown: the state write it accompanies
   * must not fail for it. The index marker is dropped instead, so the next
   * boot rebuilds the index from the states and finds this run anyway.
   *
   * @param {string} executionId - Execution identifier.
   * @param {string} status - The non-terminal status being stored.
   * @returns {Promise<void>}
   * @private
   */
  async _markActive(executionId, status) {
    if (this._indexed.get(executionId) === status) return;
    try {
      await this.documents.put(WORKFLOW_ACTIVE_NAMESPACE, executionId, {
        status,
        updatedAt: new Date().toISOString()
      });
      this._indexed.set(executionId, status);
    } catch (error) {
      this._indexed.delete(executionId);
      this.logger.error('Could not record an unfinished workflow execution in its index', {
        component: COMPONENT,
        executionId,
        error: error.message
      });
      await this._invalidateIndex();
    }
  }

  /**
   * Remove an execution from the index.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<void>}
   * @private
   */
  async _clearActive(executionId) {
    this._indexed.delete(executionId);
    try {
      await this.documents.delete(WORKFLOW_ACTIVE_NAMESPACE, executionId);
    } catch (error) {
      // A stale entry costs one state read at the next boot, which prunes it.
      this.logger.warn('Could not remove a finished workflow execution from its index', {
        component: COMPONENT,
        executionId,
        error: error.message
      });
    }
  }

  /**
   * Forget that the index is complete, so the next listing rebuilds it.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _invalidateIndex() {
    try {
      await this.documents.delete(MARKER_NAMESPACE, ACTIVE_INDEX_MARKER);
    } catch (error) {
      this.logger.error('Could not invalidate the index of unfinished workflow executions', {
        component: COMPONENT,
        error: error.message
      });
    }
  }

  /**
   * Every known execution, as metadata only.
   *
   * Served by the store's metadata listing, which never reads a state body:
   * a state carrying a whole workflow definition costs the first few
   * kilobytes of its file. The workflow retention sweep walks the namespace
   * this way at boot and once a day. Callers that only want the unfinished
   * runs use {@link WorkflowStateRepository#listActive} instead.
   *
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only ids starting with this.
   * @param {number} [options.max] - Hard record bound.
   * @returns {Promise<{items: Array<{executionId: string, updatedAt: number}>,
   *   truncated: boolean}>} The scan and whether the bound cut it short.
   */
  async listSummaries({ prefix = null, max = MAX_SCAN_STATES } = {}) {
    return this._scan({ prefix, max, includeData: false });
  }

  /**
   * Every known execution together with its state.
   *
   * Entries whose state cannot be read are dropped.
   *
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only ids starting with this.
   * @param {number} [options.max] - Hard record bound.
   * @returns {Promise<{items: Array<{executionId: string, state: Object,
   *   updatedAt: number}>, truncated: boolean}>}
   */
  async list({ prefix = null, max = MAX_SCAN_STATES } = {}) {
    const scan = await this._scan({ prefix, max, includeData: true });
    return { items: scan.items.filter(item => item.state), truncated: scan.truncated };
  }

  /**
   * Walk the namespace into one list.
   *
   * @param {Object} options
   * @param {string|null} options.prefix - Id prefix filter, or null.
   * @param {number} options.max - Hard record bound.
   * @param {boolean} options.includeData - Whether to read the states.
   * @returns {Promise<{items: Object[], truncated: boolean}>}
   * @private
   */
  async _scan({ prefix, max, includeData }) {
    const bound = Number.isFinite(max) && max > 0 ? max : MAX_SCAN_STATES;
    const found = new Map();
    let cursor = null;
    do {
      let page;
      try {
        const pageOptions = {
          limit: SCAN_PAGE_SIZE,
          ...(prefix ? { prefix } : {}),
          ...(cursor ? { cursor } : {})
        };
        // Metadata only: no state body is read, so walking an installation's
        // whole history for ids and timestamps costs a few kilobytes a state.
        page = includeData
          ? await this.documents.list(WORKFLOW_STATE_NAMESPACE, pageOptions)
          : await this.documents.listMetadata(WORKFLOW_STATE_NAMESPACE, pageOptions);
      } catch (error) {
        this.logger.warn('Could not list the workflow state namespace', {
          component: COMPONENT,
          error: error.message
        });
        cursor = null;
        break;
      }
      for (const doc of page.items) {
        if (RESERVED_KEYS.has(doc.key)) continue;
        if (includeData && !isWorkflowState(doc.data)) continue;
        found.set(doc.key, {
          executionId: doc.key,
          updatedAt: parseTime(doc.updatedAt),
          ...(includeData ? { state: doc.data } : {})
        });
      }
      cursor = page.nextCursor;
    } while (cursor && found.size < bound);
    return { items: [...found.values()], truncated: Boolean(cursor) };
  }
}

/** @type {WorkflowStateRepository|null} */
let cachedRepository = null;
/** @type {Object|null} */
let cachedProvider = null;

/**
 * The process-wide workflow state repository over the bootstrapped storage
 * provider.
 *
 * Rebuilt when the provider changes (a test swapping one in, a shutdown
 * followed by a fresh bootstrap).
 *
 * @returns {WorkflowStateRepository}
 * @throws {import('../../storage/bootstrap.js').StorageBootstrapError} When
 *   storage has not been bootstrapped.
 */
export function getWorkflowStateRepository() {
  const provider = requireStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new WorkflowStateRepository({
      documents: provider.documents,
      locks: provider.locks,
      logger
    });
  }
  return cachedRepository;
}

export default WorkflowStateRepository;
