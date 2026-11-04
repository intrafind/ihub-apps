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
    await this.documents.put(WORKFLOW_STATE_NAMESPACE, executionId, state, {
      ownerId: typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : null
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
    try {
      return Boolean(await this.documents.delete(WORKFLOW_STATE_NAMESPACE, executionId));
    } catch (error) {
      this.logger.warn('Could not remove workflow state document', {
        component: COMPONENT,
        executionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Every known execution, as metadata only.
   *
   * Cheap enough to run over the whole namespace: document bodies are not
   * read, so a state carrying a whole workflow definition costs one directory
   * entry rather than hundreds of kilobytes. Callers that then need the state
   * itself read only the entries they care about.
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
        page = await this.documents.list(WORKFLOW_STATE_NAMESPACE, {
          limit: SCAN_PAGE_SIZE,
          includeData,
          ...(prefix ? { prefix } : {}),
          ...(cursor ? { cursor } : {})
        });
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
