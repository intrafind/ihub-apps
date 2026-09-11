/**
 * ExecutionRegistry — the per-user index of workflow and agent executions.
 *
 * The API is the one every caller already uses; what changed is where the
 * records live. They used to be a per-process `Map` flushed, in whole, to
 * `contents/data/workflow-state/execution-registry.json` by a debounced
 * non-atomic `writeFile`. That store lost data four different ways: each
 * worker rewrote the entire file from its own partial map (last writer wins),
 * a concurrent reader could read a torn file, the debounce timer was reset by
 * every node-start so a fast workflow never flushed, and the boot rescan in
 * every worker marked as `failed` the very runs another worker was resuming.
 *
 * Records now live in the shared `runs` namespace as one document each, via
 * {@link RunSummaryRepository}. One document per execution is atomic, indexed
 * by its owning principal, and visible to every worker — so a run started on
 * worker 2 finally shows up in `my-executions` served by worker 1.
 *
 * Two consequences shape the code below.
 *
 * **Reads are async.** A read-through cache that answered synchronously would
 * re-create the per-worker staleness this change exists to remove, so `get`,
 * `getByUser`, `getAll`, `getActive`, `list`, `getStats` and
 * `getPendingCheckpoints` all return promises. They never reject: a storage
 * failure degrades to what this process knows, exactly as an installation
 * without a storage provider does.
 *
 * **Writes stay synchronous to call.** Every writer in the engine, the
 * workflow runner and the routes calls `register`/`updateStatus` without
 * awaiting and ignores the result, and those calls sit on hot paths (one per
 * node start). They keep that shape: the record is updated in memory and the
 * document write is queued, serialized per execution so a status patch can
 * never overtake the create that must precede it. `setArchived` and `remove`
 * are the exceptions — their results are an HTTP response body and a
 * delete-then-list, so they are awaited.
 *
 * The in-memory map is no longer the store. It holds only executions this
 * process is currently running: an entry is dropped once its terminal status
 * has been persisted, so the map is bounded by concurrency instead of growing
 * for the life of the process. While an entry is there it wins over the
 * document, because this process is the one driving that execution and its
 * queued write may not have landed yet.
 *
 * When no storage provider is available the map is the whole store and the
 * registry behaves as it always did, minus the file. That is a supported
 * state, not an error.
 *
 * @module services/workflow/ExecutionRegistry
 */
import logger from '../../utils/logger.js';
import { WorkflowStatus } from './StateManager.js';
import { getRunSummaryRepository } from '../runtime/RunSummaryRepository.js';
import { DEFAULT_STATE_DIR, resolveWorkflowStateRepository } from './WorkflowStateRepository.js';

const COMPONENT = 'ExecutionRegistry';

/** Principal prefix that marks an execution as an agent run. */
const AGENT_PRINCIPAL_PREFIX = 'agent:';

/**
 * Execution ids of planner-spawned sub-workflows.
 *
 * A child is part of its parent's run, never an entry in its own right: the
 * agent run list drops them by this prefix and the workflow UI has no page for
 * them. They are filtered out here rather than at each consumer because the
 * ledger now writes a summary for every execution the engine starts, children
 * included — without this filter they would appear in the admin execution list
 * and in its counts, which they never did.
 */
const CHILD_EXECUTION_PREFIX = 'wf-child-';

/**
 * Run kinds this registry owns. The `runs` namespace also holds chat and
 * inference runs written by the ledger; those are not executions and must
 * never reach a workflow listing.
 */
const EXECUTION_KINDS = new Set(['workflow', 'agent']);

/**
 * How long a namespace scan's result is reused.
 *
 * Short enough that a listing is never visibly stale — the caller's own runs
 * are re-merged from memory on every call regardless — and long enough that a
 * burst of requests costs one walk of the `runs` namespace instead of one
 * each. That is what makes `GET /api/agents/runs` safe to leave open to every
 * signed-in user, which is what it has always been.
 */
const EXECUTION_SCAN_TTL_MS = 5000;

/** Statuses after which an execution stops changing. */
const TERMINAL_STATUSES = new Set([
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED
]);

/** Statuses the `getActive()` listing reports. */
const ACTIVE_STATUSES = new Set([WorkflowStatus.RUNNING, WorkflowStatus.PAUSED]);

/**
 * The ledger's terminal vocabulary in the registry's terms.
 *
 * The two stores now share one document per execution and they name the same
 * outcomes differently: an execution that fails is `failed` to the workflow
 * engine and `error` to the ledger, and a cancelled one is `cancelled` and
 * `aborted` respectively. Whichever of the two writes the run's end last, a
 * consumer of this registry — the executions list, its status filter, the
 * badge in the UI — must see the workflow vocabulary it has always seen.
 *
 * The translation is on read only. The stored value is left as whichever
 * writer set it, so a ledger listing still reads the ledger's own words back.
 */
const LEDGER_STATUS_ALIASES = {
  error: WorkflowStatus.FAILED,
  aborted: WorkflowStatus.CANCELLED
};

/**
 * Whether a run summary is an execution this registry lists.
 *
 * @param {Object} summary - Run summary from the repository.
 * @returns {boolean}
 */
function isExecutionSummary(summary) {
  if (!summary || typeof summary.runId !== 'string') return false;
  if (!EXECUTION_KINDS.has(summary.kind)) return false;
  return !summary.runId.startsWith(CHILD_EXECUTION_PREFIX);
}

/**
 * The run kind implied by an execution's principal, derived the way every
 * authorization check already derives it.
 *
 * @param {string} userId - Owning principal.
 * @returns {'agent'|'workflow'}
 */
function executionKind(userId) {
  return typeof userId === 'string' && userId.startsWith(AGENT_PRINCIPAL_PREFIX)
    ? 'agent'
    : 'workflow';
}

/**
 * The registry's contribution to a run summary.
 *
 * Every registry write sends the whole projection rather than just the field
 * that changed. The ledger writes a summary for the same run id at `run/start`
 * and that write is a replace, so a registry write that carried only its delta
 * could leave the record without a workflow name or an owner if the two
 * crossed. Sending the projection each time means the next status update
 * repairs the record, and since the projection omits every ledger-owned field
 * (`identityMode`, `parentRunId`, `model`, `usage`, `finishReason`, `refs`) a
 * merge in the other direction loses nothing either.
 *
 * `anonymous` is always false: an execution is authorized against the user id
 * the workflow routes compare, and on an installation with anonymous access
 * that id is the shared string `anonymous`. Recording the run as anonymous
 * would take it out of its own owner's execution list.
 *
 * @param {Object} execution - Registry record.
 * @returns {Object} Fields to merge into the run summary.
 */
function toSummaryFields(execution) {
  return {
    runId: execution.executionId,
    kind: executionKind(execution.userId),
    ownerId: execution.userId,
    anonymous: false,
    source: execution.source,
    status: execution.status,
    startedAt: execution.startedAt,
    updatedAt: execution.updatedAt,
    endedAt: execution.completedAt,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    currentNode: execution.currentNode,
    pendingCheckpoint: execution.pendingCheckpoint,
    inputPreview: execution.inputPreview,
    models: execution.models,
    triggeredBy: execution.triggeredBy,
    archived: execution.archived
  };
}

/**
 * The document written when an execution has no summary yet.
 *
 * `refs.executionId` is added only here: on an update it would replace the
 * richer reference set the ledger records (chat id, profile id, workflow id).
 *
 * @param {Object} execution - Registry record.
 * @returns {Object} A complete run summary.
 */
function toNewSummary(execution) {
  return { ...toSummaryFields(execution), refs: { executionId: execution.executionId } };
}

/**
 * The registry record a caller sees, rebuilt from a stored run summary.
 *
 * The vocabularies differ by three names — `runId`/`executionId`,
 * `ownerId`/`userId`, `endedAt`/`completedAt` — and every consumer of this
 * class speaks the registry's, so the translation happens here and nowhere
 * else.
 *
 * @param {Object} summary - Run summary from the repository.
 * @returns {Object} Registry record.
 */
function fromSummary(summary) {
  return {
    executionId: summary.runId,
    userId: summary.ownerId || 'unknown',
    workflowId: summary.workflowId || 'unknown',
    workflowName: summary.workflowName || { en: summary.workflowId || 'Unknown Workflow' },
    status: LEDGER_STATUS_ALIASES[summary.status] || summary.status || WorkflowStatus.PENDING,
    startedAt: summary.startedAt || null,
    updatedAt: summary.updatedAt || summary.startedAt || null,
    currentNode: summary.currentNode ?? null,
    pendingCheckpoint: summary.pendingCheckpoint ?? null,
    completedAt: summary.endedAt ?? null,
    // Left null rather than defaulted: the agent run list treats a record
    // with no source as "cannot tell, keep it", which is what an execution
    // recovered from a checkpoint has always been.
    source: summary.source ?? null,
    inputPreview: summary.inputPreview ?? null,
    models: Array.isArray(summary.models) ? [...summary.models] : [],
    triggeredBy: summary.triggeredBy ?? null,
    archived: summary.archived === true
  };
}

/**
 * Order executions newest first, the order every consumer of this registry
 * has always presented.
 *
 * @param {Object} a - Registry record.
 * @param {Object} b - Registry record.
 * @returns {number}
 */
function byStartedAtDesc(a, b) {
  return new Date(b.startedAt) - new Date(a.startedAt);
}

/**
 * Apply `offset` then `limit`, treating a missing or non-positive limit as
 * "everything from the offset" — the behaviour the listings have always had.
 *
 * @param {Object[]} records - Sorted records.
 * @param {Object} filters - Filters carrying `limit` / `offset`.
 * @returns {Object[]}
 */
function paginate(records, filters) {
  let out = records;
  if (filters.offset && filters.offset > 0) out = out.slice(filters.offset);
  if (filters.limit && filters.limit > 0) out = out.slice(0, filters.limit);
  return out;
}

/**
 * Count executions the way the admin overview presents them.
 *
 * The shape is load-bearing — the admin UI reads `totalExecutions`,
 * `totalUsers` and `byStatus` directly.
 *
 * @param {Object[]} executions - Registry records.
 * @returns {{totalExecutions: number, totalUsers: number, byStatus: Object}}
 */
function summarize(executions) {
  const byStatus = {};
  const users = new Set();
  for (const execution of executions) {
    byStatus[execution.status] = (byStatus[execution.status] || 0) + 1;
    if (execution.userId) users.add(execution.userId);
  }
  return {
    totalExecutions: executions.length,
    totalUsers: users.size,
    byStatus
  };
}

/**
 * ExecutionRegistry tracks all workflow executions by user for listing and
 * recovery, backed by the shared `runs` namespace.
 *
 * @example
 * const registry = new ExecutionRegistry();
 *
 * registry.register('wf-exec-123', {
 *   userId: 'user-1',
 *   workflowId: 'workflow-1',
 *   workflowName: { en: 'Research Workflow' },
 *   status: 'running',
 *   startedAt: new Date().toISOString()
 * });
 *
 * const userExecutions = await registry.getByUser('user-1');
 */
export class ExecutionRegistry {
  /**
   * Creates a new ExecutionRegistry instance
   * @param {Object} [options] - Configuration options
   * @param {string} [options.stateDir] - Directory holding the workflow
   *   states that {@link ExecutionRegistry#loadFromDisk} recovers from.
   * @param {import('../runtime/RunSummaryRepository.js').RunSummaryRepository} [options.summaries]
   *   Repository to store records in. Injected by tests; by default the
   *   process-wide one is resolved per call, so a registry constructed before
   *   storage came up still uses it once it has.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   */
  constructor(options = {}) {
    /**
     * Executions this process is currently running. Not the store: entries
     * are dropped once their terminal status has been persisted.
     * @type {Map<string, Object>}
     * @private
     */
    this.executions = new Map();

    /**
     * Last namespace scan, held for {@link EXECUTION_SCAN_TTL_MS}. The local
     * executions are *not* in here — they are merged on every read, so this
     * memo can never make a caller's own run look stale.
     * @type {{at: number, records: Array<[string, Object]>}|null}
     * @private
     */
    this._scanCache = null;

    /**
     * The scan currently running, so concurrent callers share one walk rather
     * than starting one each.
     * @type {Promise<Object[]>|null}
     * @private
     */
    this._scanInFlight = null;

    /**
     * User to executions mapping over {@link ExecutionRegistry#executions}.
     * @type {Map<string, Set<string>>}
     * @private
     */
    this.userExecutions = new Map();

    /**
     * Directory the workflow states are read from
     * @type {string}
     */
    this.stateDir = options.stateDir || DEFAULT_STATE_DIR;

    /**
     * Flag indicating whether the legacy recovery scan has run
     * @type {boolean}
     * @private
     */
    this._loaded = false;

    /**
     * Injected repository, or null to resolve the shared one per call
     * @type {import('../runtime/RunSummaryRepository.js').RunSummaryRepository|null}
     * @private
     */
    this._summaries = options.summaries || null;

    /**
     * Tail of the pending write chain per execution, so writes for one
     * execution apply in the order they were made
     * @type {Map<string, Promise<void>>}
     * @private
     */
    this._writes = new Map();

    /** @private */
    this.logger = options.logger || logger;
  }

  /**
   * The repository records are stored in.
   *
   * @returns {import('../runtime/RunSummaryRepository.js').RunSummaryRepository}
   * @private
   */
  _repo() {
    return this._summaries || getRunSummaryRepository();
  }

  /**
   * The repository, or null when nothing can be stored right now.
   *
   * @returns {import('../runtime/RunSummaryRepository.js').RunSummaryRepository|null}
   * @private
   */
  _store() {
    try {
      const repo = this._repo();
      return repo.isAvailable() ? repo : null;
    } catch {
      return null;
    }
  }

  /**
   * Queue a document write behind the ones already pending for this
   * execution.
   *
   * Serializing per execution is what makes the synchronous writer API safe:
   * `register()` and the `updateStatus()` that follows it milliseconds later
   * are both fire-and-forget, and a status patch that overtook the create
   * would find no document and be dropped.
   *
   * @param {string} executionId - Execution the write belongs to.
   * @param {() => Promise<unknown>} fn - The write.
   * @returns {Promise<void>} Settles when this write has been attempted.
   * @private
   */
  _enqueue(executionId, fn) {
    const previous = this._writes.get(executionId) || Promise.resolve();
    const next = previous.then(fn).then(
      () => undefined,
      error => {
        this.logger.warn('Failed to persist execution record', {
          component: COMPONENT,
          executionId,
          error: error.message
        });
      }
    );
    this._writes.set(executionId, next);
    next.then(() => {
      if (this._writes.get(executionId) === next) this._writes.delete(executionId);
    });
    return next;
  }

  /**
   * Wait for the queued document writes to settle.
   *
   * Only the writes queued so far: awaiting a chain that keeps growing under
   * load would never settle.
   *
   * @param {string} [executionId] - One execution, or every pending write.
   * @returns {Promise<void>}
   */
  async flushWrites(executionId) {
    if (executionId) {
      await (this._writes.get(executionId) || Promise.resolve());
      return;
    }
    await Promise.all([...this._writes.values()]);
  }

  /**
   * Track an execution in the in-process map.
   *
   * @param {Object} execution - Registry record.
   * @private
   */
  _track(execution) {
    this.executions.set(execution.executionId, execution);
    if (!this.userExecutions.has(execution.userId)) {
      this.userExecutions.set(execution.userId, new Set());
    }
    this.userExecutions.get(execution.userId).add(execution.executionId);
  }

  /**
   * Stop tracking an execution in the in-process map.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {boolean} True when it was tracked.
   * @private
   */
  _untrack(executionId) {
    const execution = this.executions.get(executionId);
    if (!execution) return false;
    const userSet = this.userExecutions.get(execution.userId);
    if (userSet) {
      userSet.delete(executionId);
      if (userSet.size === 0) this.userExecutions.delete(execution.userId);
    }
    this.executions.delete(executionId);
    return true;
  }

  /**
   * Merge the executions this process is running into a set read from the
   * store, letting the local copy win.
   *
   * The local copy is only ever present for an execution this process is
   * driving, and its queued write may not have landed yet — so it is the more
   * recent of the two, and it is what keeps a run visible in the listing taken
   * immediately after it was started.
   *
   * @param {Map<string, Object>} records - Records read from the store.
   * @param {(execution: Object) => boolean} [predicate] - Which local
   *   executions belong in this listing.
   * @returns {Object[]} The merged records.
   * @private
   */
  _mergeLocal(records, predicate) {
    for (const execution of this.executions.values()) {
      if (predicate && !predicate(execution)) continue;
      records.set(execution.executionId, { ...execution });
    }
    return [...records.values()];
  }

  /**
   * Every execution in the store, plus the ones this process is running.
   *
   * This is a scan of the `runs` namespace, and the docstring here used to say
   * it was "administrator-initiated rather than per-request". That was wrong:
   * `GET /api/agents/runs` is `authRequired, authenticatedOnly`, so any
   * signed-in user reaches it, and `/api/agents` is not behind the rate
   * limiter. A namespace-sized scan was therefore something a signed-in user
   * could ask for as often as they liked.
   *
   * The scan itself cannot be narrowed. What separates an execution from the
   * chat and inference runs sharing the namespace is the stored `kind` field,
   * not the key and not the owner: a key prefix would hide executions
   * (`WorkflowEngine.start` accepts a caller-supplied `executionId`, and the
   * legacy registry holds arbitrary ids), and the owner index cannot help
   * because a summary's `ownerId` is `agent:<profileId>` while the question a
   * non-admin asks is "runs *I* triggered".
   *
   * So the repetition is what is bounded here rather than the scan: results
   * are held briefly and concurrent callers share one in-flight walk. A burst
   * of requests costs one scan instead of one each. The first scan is still
   * O(N) — the fix for that is an index on the discriminator, which is a
   * change to the stored shape.
   *
   * @returns {Promise<Object[]>} Registry records, unsorted.
   * @private
   */
  async _allExecutions() {
    const now = Date.now();
    if (this._scanCache && now - this._scanCache.at < EXECUTION_SCAN_TTL_MS) {
      // Re-merge the local executions: they change in this process between
      // scans, and serving a stale view of *our own* runs would be a
      // regression against the in-memory registry this replaced.
      return this._mergeLocal(new Map(this._scanCache.records));
    }
    if (this._scanInFlight) return this._scanInFlight;

    this._scanInFlight = this._scanExecutions()
      .then(records => {
        this._scanCache = { at: Date.now(), records: [...records] };
        return this._mergeLocal(new Map(records));
      })
      .finally(() => {
        this._scanInFlight = null;
      });
    return this._scanInFlight;
  }

  /**
   * The store half of {@link ExecutionRegistry#_allExecutions}, without the
   * local merge or the memo — split out so the memo has one thing to hold.
   *
   * @returns {Promise<Map<string, Object>>} Records by execution id.
   * @private
   */
  async _scanExecutions() {
    const records = new Map();
    const store = this._store();
    if (store) {
      try {
        // `match` runs inside the repository's scan, so the bound counts
        // executions rather than documents: the `runs` namespace is shared
        // with every chat and inference run the ledger records, and those
        // sort before `wf-exec-…`.
        const page = await store.listAll({ match: isExecutionSummary });
        for (const summary of page.items) {
          records.set(summary.runId, fromSummary(summary));
        }
      } catch (error) {
        this.logger.warn('Could not read executions from storage; reporting local runs only', {
          component: COMPONENT,
          error: error.message
        });
      }
    }
    return records;
  }

  /**
   * Registers a new workflow execution
   *
   * Returns immediately; the document write is queued. Every caller today
   * ignores the return value and none of them awaits, so making this async
   * would silently turn a dropped write into an unhandled rejection on a hot
   * path.
   *
   * @param {string} executionId - Unique execution identifier
   * @param {Object} metadata - Execution metadata
   * @param {string} metadata.userId - User who started the execution
   * @param {string} metadata.workflowId - Workflow definition ID
   * @param {Object} metadata.workflowName - Localized workflow name
   * @param {string} metadata.status - Execution status
   * @param {string} metadata.startedAt - ISO timestamp when execution started
   * @param {string} [metadata.source] - How the run was launched
   * @param {string} [metadata.inputPreview] - Sanitized preview of the input
   * @param {string[]} [metadata.models] - Models the workflow may use
   * @param {Object} [metadata.triggeredBy] - Human who initiated the run
   * @returns {Object} The registered execution metadata
   *
   * @example
   * registry.register('wf-exec-123', {
   *   userId: 'user-1',
   *   workflowId: 'research-workflow',
   *   workflowName: { en: 'Research Assistant' },
   *   status: 'running',
   *   startedAt: new Date().toISOString()
   * });
   */
  register(executionId, metadata) {
    const {
      userId,
      workflowId,
      workflowName,
      status,
      startedAt,
      source,
      inputPreview,
      models,
      triggeredBy
    } = metadata;

    if (!executionId) {
      throw new Error('executionId is required');
    }

    if (!userId) {
      throw new Error('userId is required');
    }

    if (!workflowId) {
      throw new Error('workflowId is required');
    }

    const execution = {
      executionId,
      userId,
      workflowId,
      workflowName: workflowName || { en: workflowId },
      status: status || WorkflowStatus.PENDING,
      startedAt: startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentNode: null,
      pendingCheckpoint: null,
      completedAt: null,
      source: source || 'ui',
      inputPreview: inputPreview || null,
      models: Array.isArray(models) ? models : [],
      // Human who initiated the run — used by per-user authorization on
      // the list/detail/artifact endpoints. Separate from `userId` which
      // is the service-account principal for agent runs.
      triggeredBy: triggeredBy && typeof triggeredBy === 'object' ? triggeredBy : null,
      archived: false
    };

    this._track(execution);

    this.logger.info('Registered execution', {
      component: COMPONENT,
      executionId,
      userId,
      workflowId
    });

    this._enqueue(executionId, async () => {
      const store = this._store();
      if (!store) return;
      // One locked upsert, never a read then a replace: the ledger records a
      // summary for the same run id at `run/start` from a queue of its own,
      // and the two chains have no ordering between them. A create fallback
      // that replaced would drop the principal's identity mode, the parent
      // run, the model and the cross-references the ledger carries whenever
      // its write landed in between.
      await store.merge(executionId, toSummaryFields(execution), {
        // Only on create: on a merge this would replace the richer reference
        // set the ledger records (chat id, profile id, workflow id).
        defaults: { refs: { executionId } }
      });
    });

    return { ...execution };
  }

  /**
   * Updates the status of an execution
   *
   * Returns immediately; the document write is queued. An execution this
   * process is not running has no local record, so there is nothing to return
   * — the update still reaches the shared document, which is how the orphan
   * sweeper now marks runs left behind by a previous process.
   *
   * @param {string} executionId - The execution identifier
   * @param {string} status - New status value
   * @param {Object} [updates] - Additional fields to update
   * @returns {Object|null} Updated execution, or null when this process is not
   *   running it
   *
   * @example
   * registry.updateStatus('wf-exec-123', 'paused', {
   *   currentNode: 'approval-node',
   *   pendingCheckpoint: { id: 'ckpt-1', message: 'Please approve' }
   * });
   */
  updateStatus(executionId, status, updates = {}) {
    const now = new Date().toISOString();
    const execution = this.executions.get(executionId);
    const terminal = TERMINAL_STATUSES.has(status);

    let fields;
    if (execution) {
      execution.status = status;
      execution.updatedAt = now;
      if (updates.currentNode !== undefined) execution.currentNode = updates.currentNode;
      if (updates.pendingCheckpoint !== undefined) {
        execution.pendingCheckpoint = updates.pendingCheckpoint;
      }
      if (terminal) execution.completedAt = now;
      fields = toSummaryFields(execution);
    } else {
      fields = { status, updatedAt: now };
      if (updates.currentNode !== undefined) fields.currentNode = updates.currentNode;
      if (updates.pendingCheckpoint !== undefined) {
        fields.pendingCheckpoint = updates.pendingCheckpoint;
      }
      if (terminal) fields.endedAt = now;
    }

    this.logger.debug('Updated execution status', {
      component: COMPONENT,
      executionId,
      status
    });

    this._enqueue(executionId, async () => {
      const store = this._store();
      if (!store) return;
      await store.patch(executionId, fields);
      // A finished run is no longer this process's business. Dropping it only
      // after the write lands keeps it visible to a listing taken in between,
      // and keeping it when there is no store preserves the in-memory-only
      // behaviour of an installation without a storage provider.
      if (terminal) this._untrack(executionId);
    });

    return execution ? { ...execution } : null;
  }

  /**
   * Sets a pending human checkpoint on an execution
   * @param {string} executionId - The execution identifier
   * @param {Object} checkpoint - Checkpoint data
   * @returns {Object|null} Updated execution, or null when this process is not
   *   running it
   */
  setPendingCheckpoint(executionId, checkpoint) {
    return this.updateStatus(executionId, WorkflowStatus.PAUSED, {
      pendingCheckpoint: checkpoint
    });
  }

  /**
   * Clears a pending checkpoint after user response
   * @param {string} executionId - The execution identifier
   * @returns {Object|null} Updated execution, or null when this process is not
   *   running it
   */
  clearPendingCheckpoint(executionId) {
    const now = new Date().toISOString();
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.pendingCheckpoint = null;
      execution.updatedAt = now;
    }
    const fields = execution
      ? toSummaryFields(execution)
      : { pendingCheckpoint: null, updatedAt: now };

    this._enqueue(executionId, async () => {
      const store = this._store();
      if (store) await store.patch(executionId, fields);
    });

    return execution ? { ...execution } : null;
  }

  /**
   * Sets the archived flag on an execution
   *
   * Async because the archive endpoint answers with the updated record, and a
   * finished run is normally not in this process's memory to answer from.
   *
   * @param {string} executionId - The execution identifier
   * @param {boolean} archived - Archive state
   * @returns {Promise<Object|null>} Updated execution or null if not found
   */
  async setArchived(executionId, archived) {
    const now = new Date().toISOString();
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.archived = Boolean(archived);
      execution.updatedAt = now;
    }
    const fields = execution
      ? toSummaryFields(execution)
      : { archived: Boolean(archived), updatedAt: now };

    let stored = null;
    await this._enqueue(executionId, async () => {
      const store = this._store();
      if (store) stored = await store.patch(executionId, fields);
    });

    if (execution) return { ...execution };
    return stored ? fromSummary(stored) : null;
  }

  /**
   * Gets an execution by ID
   *
   * The local copy wins, on the same rule the listings use: it exists only
   * while this process is driving the execution, which makes it at least as
   * recent as the document — a status set a moment ago may still be queued.
   *
   * Never rejects: a storage failure falls back to what this process knows,
   * because the callers are authorization checks that must answer with a 403
   * or a 404 rather than a 500.
   *
   * @param {string} executionId - The execution identifier
   * @returns {Promise<Object|null>} Execution metadata or null if not found
   */
  async get(executionId) {
    const local = this.executions.get(executionId);
    if (local) return { ...local };
    const store = this._store();
    if (!store) return null;
    try {
      const summary = await store.get(executionId);
      if (isExecutionSummary(summary)) return fromSummary(summary);
    } catch (error) {
      this.logger.warn('Could not read execution from storage', {
        component: COMPONENT,
        executionId,
        error: error.message
      });
    }
    return null;
  }

  /**
   * Gets all executions for a specific user
   *
   * @param {string} userId - The user identifier
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.status] - Filter by status
   * @param {boolean} [filters.includeArchived] - Include archived runs
   * @param {'only'} [filters.archived] - Return only archived runs
   * @param {number} [filters.limit] - Maximum number of results
   * @param {number} [filters.offset] - Skip first N results
   * @returns {Promise<Object[]>} Array of execution metadata, newest first
   *
   * @example
   * const running = await registry.getByUser('user-1', { status: 'running' });
   * const recent = await registry.getByUser('user-1', { limit: 10 });
   */
  async getByUser(userId, filters = {}) {
    const records = new Map();
    const store = this._store();
    if (store && userId) {
      try {
        // Everything for this owner: the archived rule below is the
        // registry's own tri-state and is applied once, after the local
        // executions have been merged in. `match` narrows inside the scan so
        // the owner's chat runs — which share this namespace and sort before
        // `wf-exec-…` — cannot consume the whole record bound and leave the
        // listing empty.
        const page = await store.listByOwner(userId, {
          archived: 'all',
          match: isExecutionSummary
        });
        for (const summary of page.items) {
          records.set(summary.runId, fromSummary(summary));
        }
      } catch (error) {
        this.logger.warn('Could not list executions for user; reporting local runs only', {
          component: COMPONENT,
          userId,
          error: error.message
        });
      }
    }

    let executions = this._mergeLocal(records, execution => execution.userId === userId);

    // Apply archived filter — default hides archived runs.
    if (filters.archived === 'only') {
      executions = executions.filter(e => e.archived === true);
    } else if (!filters.includeArchived) {
      executions = executions.filter(e => e.archived !== true);
    }

    if (filters.status) {
      executions = executions.filter(e => e.status === filters.status);
    }

    executions.sort(byStartedAtDesc);

    return paginate(executions, filters);
  }

  /**
   * Gets all active (running or paused) executions
   * @returns {Promise<Object[]>} Array of active execution metadata
   */
  async getActive() {
    const executions = await this._allExecutions();
    return executions.filter(e => ACTIVE_STATUSES.has(e.status));
  }

  /**
   * Get all executions regardless of status. Callers (e.g. the agent runs
   * listing route) filter by userId / source afterwards.
   * @returns {Promise<Object[]>}
   */
  async getAll() {
    return this._allExecutions();
  }

  /**
   * Gets all executions that are paused with pending checkpoints
   * @returns {Promise<Object[]>} Array of executions awaiting human input
   */
  async getPendingCheckpoints() {
    const executions = await this._allExecutions();
    return executions.filter(e => e.status === WorkflowStatus.PAUSED && e.pendingCheckpoint);
  }

  /**
   * The administrative execution listing: filtered, searched, ordered newest
   * first and paginated, with the statistics that accompany it.
   *
   * One scan serves the page and the counts; the counts describe every
   * execution, not the page.
   *
   * @param {Object} [filters]
   * @param {string} [filters.status] - Keep only this status; `'all'` keeps every status
   * @param {string} [filters.search] - Case-insensitive match on user, workflow name or id
   * @param {number} [filters.limit] - Page size
   * @param {number} [filters.offset] - Records to skip
   * @returns {Promise<{executions: Object[], total: number, stats: Object}>}
   */
  async list(filters = {}) {
    const all = await this._allExecutions();
    let executions = all;

    if (filters.status && filters.status !== 'all') {
      executions = executions.filter(e => e.status === filters.status);
    }

    if (filters.search) {
      const needle = String(filters.search).toLowerCase();
      executions = executions.filter(e => {
        const userId = (e.userId || '').toLowerCase();
        const workflowName =
          typeof e.workflowName === 'object'
            ? Object.values(e.workflowName).join(' ').toLowerCase()
            : (e.workflowName || '').toLowerCase();
        const workflowId = (e.workflowId || '').toLowerCase();
        return (
          userId.includes(needle) || workflowName.includes(needle) || workflowId.includes(needle)
        );
      });
    }

    executions.sort(byStartedAtDesc);

    return {
      executions: paginate(executions, filters),
      total: executions.length,
      stats: summarize(all)
    };
  }

  /**
   * Removes an execution from the registry
   *
   * Async because the delete endpoint answers only once the record is gone —
   * a listing taken right afterwards reads the store, not this process's
   * memory.
   *
   * @param {string} executionId - The execution identifier
   * @returns {Promise<boolean>} True if removed, false if not found
   */
  async remove(executionId) {
    const hadLocal = this._untrack(executionId);

    let removed = false;
    await this._enqueue(executionId, async () => {
      const store = this._store();
      if (store) removed = await store.remove(executionId);
    });

    if (hadLocal || removed) {
      this.logger.info('Removed execution from registry', { component: COMPONENT, executionId });
    }
    return hadLocal || removed;
  }

  /**
   * Recovers executions that have a checkpoint directory on disk but no run
   * summary.
   *
   * The whole-file registry is not read here any more: it is imported into the
   * `runs` namespace once, on first boot, and left on disk. What is left for
   * this scan is the case that import cannot cover — a state directory whose
   * execution the registry file never held. Recovery is degraded by nature
   * (the checkpoint knows nothing about `source`, `models` or who triggered
   * the run) so it only ever creates a record that does not exist; it never
   * overwrites one.
   *
   * @returns {Promise<void>}
   */
  async loadFromDisk() {
    try {
      const recovered = await this._scanCheckpointDirectories();
      this._loaded = true;
      this.logger.info('Registry loaded', {
        component: COMPONENT,
        recoveredFromCheckpoints: recovered
      });
    } catch (error) {
      this.logger.error('Failed to recover executions from checkpoints', {
        component: COMPONENT,
        error
      });
      this._loaded = true; // Mark as loaded even on error to allow fresh start
    }
  }

  /**
   * Scans stored workflow states to recover execution metadata
   *
   * Goes through {@link WorkflowStateRepository} rather than reading
   * `latest.json` itself, so it sees a state wherever it lives — the
   * `workflow-state` namespace, or the legacy per-execution directory that
   * still sits beside it until the import has carried it over.
   *
   * @returns {Promise<number>} How many executions were recovered
   * @private
   */
  async _scanCheckpointDirectories() {
    const states = resolveWorkflowStateRepository(this.stateDir);
    const { items, truncated } = await states.listSummaries();
    if (truncated) {
      this.logger.warn('Workflow state scan hit its bound; recovery is incomplete', {
        component: COMPONENT,
        scanned: items.length
      });
    }

    let recovered = 0;
    for (const { executionId } of items) {
      // A sub-workflow belongs to its parent's run and is never listed.
      if (executionId.startsWith(CHILD_EXECUTION_PREFIX)) continue;
      if (await this.get(executionId)) continue;

      const state = await states.read(executionId);
      if (!state) continue;

      // Only what a checkpoint actually knows. `source`, `inputPreview`,
      // `models` and `triggeredBy` were never recorded in the state and are
      // left unset rather than guessed — a guessed `source` would drop a
      // recovered agent run out of the agent run list.
      const execution = {
        executionId,
        userId: state.data?._workflow?.startedBy || 'unknown',
        workflowId: state.workflowId || 'unknown',
        workflowName: { en: state.workflowId || 'Unknown Workflow' },
        status: state.status || WorkflowStatus.PENDING,
        startedAt: state.createdAt || new Date().toISOString(),
        updatedAt: state.updatedAt || new Date().toISOString(),
        currentNode: state.currentNodes?.[0] || null,
        pendingCheckpoint: state.pendingCheckpoint || null,
        completedAt: state.completedAt || null,
        source: null,
        inputPreview: null,
        models: [],
        triggeredBy: null,
        archived: false
      };

      this._enqueue(executionId, async () => {
        const store = this._store();
        if (!store) {
          // No provider: this process's memory is the whole registry, which
          // is where recovery has always put these records.
          this._track(execution);
          return;
        }
        // Re-checked under the write queue: a run registered while the scan
        // was reading the state must not be overwritten by the degraded copy
        // the checkpoint yields.
        if (await store.get(executionId)) return;
        await store.put(toNewSummary(execution));
      });
      recovered += 1;

      this.logger.info('Recovered execution from checkpoint', {
        component: COMPONENT,
        executionId,
        status: state.status
      });
    }

    await this.flushWrites();
    return recovered;
  }

  /**
   * Gets statistics about the registry
   * @returns {Promise<{totalExecutions: number, totalUsers: number, byStatus: Object}>}
   */
  async getStats() {
    return summarize(await this._allExecutions());
  }
}

// Singleton instance for application-wide use
let registryInstance = null;

/**
 * Gets the singleton ExecutionRegistry instance
 * @param {Object} [options] - Options for creating the instance
 * @returns {ExecutionRegistry} The registry instance
 */
export function getExecutionRegistry(options = {}) {
  if (!registryInstance) {
    registryInstance = new ExecutionRegistry(options);
  }
  return registryInstance;
}

/**
 * Resets the singleton instance (useful for testing)
 */
export function resetExecutionRegistry() {
  registryInstance = null;
}

export default ExecutionRegistry;
