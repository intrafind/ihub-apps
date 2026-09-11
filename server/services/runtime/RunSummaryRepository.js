/**
 * RunSummaryRepository — one document per run in the `runs` namespace.
 *
 * This is *the* per-principal index of everything that ran: chats, workflow
 * executions and agent runs alike. It replaces two stores that each held half
 * of it — the ledger's per-day `index/<date>.jsonl` files (no owner index, a
 * full scan per listing) and `execution-registry.json` (one file rewritten in
 * whole by every worker from its own partial map, last writer wins). So the
 * record below is the union of what those two carried, field for field.
 *
 * Three properties follow from putting it here:
 *
 *   - **Atomic.** One document per run, written through the provider, so two
 *     workers recording two different runs can no longer erase each other.
 *   - **Owner-indexed.** `ownerId` is the run's principal, so "this user's
 *     runs" is an index read rather than a scan of every run ever recorded.
 *   - **Shared.** A run started on worker 2 is visible to worker 1, which the
 *     per-process registry Map never was.
 *
 * Reads are async by design (see D3 in the consolidation contract): a
 * read-through in-memory cache answering synchronously would re-create exactly
 * the per-worker staleness this store exists to remove.
 *
 * Ordering is done in memory. `DocumentStore.list` is ascending by key and run
 * ids are uuids, so every listing here loads the matching documents, sorts
 * them by `startedAt` descending and pages the result. That is affordable
 * because it is bounded — and when a bound truncates, it is logged, because a
 * silent cap reads to an administrator as "that is all there is".
 *
 * Everything degrades to a no-op when no storage provider is available. That
 * is a supported state, not an error: the caller keeps whatever non-persistent
 * behaviour it had before.
 *
 * @module services/runtime/RunSummaryRepository
 */
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';

const COMPONENT = 'RunSummaryRepository';

/** Namespace holding one summary document per run. */
export const RUNS_NAMESPACE = RUNTIME_NAMESPACES.runs;

/**
 * Every field a run summary carries. The record shape is closed: a writer's
 * unknown field is dropped by {@link normalizeRunSummary} rather than stored,
 * so all three writers (the ledger, the execution registry, the importer)
 * produce documents of one shape and a reader never has to guess. Exported so
 * a writer can check its mapping against it instead of discovering a silent
 * drop in production.
 *
 * @type {readonly string[]}
 */
export const RUN_SUMMARY_FIELDS = Object.freeze([
  'runId',
  'kind',
  'ownerId',
  'identityMode',
  'anonymous',
  'parentRunId',
  'refs',
  'source',
  'status',
  'startedAt',
  'updatedAt',
  'endedAt',
  'finishReason',
  'usage',
  'model',
  'workflowId',
  'workflowName',
  'currentNode',
  'pendingCheckpoint',
  'inputPreview',
  'models',
  'triggeredBy',
  'archived'
]);

/** Documents fetched per `list()` call while walking the namespace. */
const SCAN_PAGE_SIZE = 200;

/**
 * Hard bound on how many of one owner's runs are loaded for the in-memory
 * sort. Past it the owner's oldest-keyed runs are invisible to the listing —
 * and since run ids are uuids, "oldest-keyed" has no relation to recency, so
 * the truncation is logged rather than left to be inferred from a short page.
 */
const MAX_OWNER_RUNS = 1000;

/**
 * Hard bound on an admin scan of the whole namespace. A scan that tried to
 * hold an unbounded namespace in memory would fail on the installation that
 * needs it most; the ledger's own retention is what keeps the real number far
 * below this.
 */
const MAX_SCAN_RUNS = 20_000;

/**
 * Hard bound on how many *documents* a scan may examine, whatever it keeps.
 *
 * The record bounds above count records that matched, so a namespace whose
 * runs are overwhelmingly of another kind — a busy installation's chat runs,
 * against a handful of workflow executions — cannot starve a filtered listing
 * of its budget. This second bound is what still makes such a scan terminate.
 */
const MAX_EXAMINED_RUNS = 100_000;

/**
 * Lease for one read-modify-write. Short: the critical section is a read and a
 * write, and a lease held longer than that means a dead worker whose lock we
 * want taken over quickly.
 */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

/** Fields a patch may never change — identity and prototype safety. */
const PROTECTED_FIELDS = new Set(['runId', '__proto__', 'constructor', 'prototype']);

/** An empty listing page, shared by every unavailable-storage return. */
const EMPTY_PAGE = Object.freeze({ items: [], total: 0, truncated: false });

/**
 * A non-empty string, or null. Used so an absent field is stored as null
 * rather than as the string 'undefined'.
 *
 * @param {unknown} value - Candidate.
 * @returns {string|null}
 */
function str(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A plain object, or null.
 *
 * @param {unknown} value - Candidate.
 * @returns {Object|null}
 */
function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Build the canonical stored form of a run summary.
 *
 * Fields outside {@link RUN_SUMMARY_FIELDS} are dropped. `runId` is null when
 * the input has none, which every write path treats as "not storable" rather
 * than inventing a key.
 *
 * @param {Object} [input] - Summary as a writer describes it.
 * @returns {Object} The record to store.
 */
export function normalizeRunSummary(input = {}) {
  const startedAt = str(input.startedAt) || new Date().toISOString();
  return {
    runId: str(input.runId),
    kind: str(input.kind),
    ownerId: str(input.ownerId),
    identityMode: str(input.identityMode),
    anonymous: input.anonymous === true,
    parentRunId: str(input.parentRunId),
    refs: obj(input.refs) ? { ...input.refs } : {},
    source: str(input.source),
    // A summary is written when a run starts, so "running" is the state a
    // writer that names none is describing.
    status: str(input.status) || 'running',
    startedAt,
    updatedAt: str(input.updatedAt) || startedAt,
    endedAt: str(input.endedAt),
    finishReason: str(input.finishReason),
    usage: obj(input.usage),
    model: str(input.model),
    workflowId: str(input.workflowId),
    // Localized ({en: '…'}) for workflows, a plain string for anything else.
    workflowName: obj(input.workflowName) || str(input.workflowName),
    currentNode: str(input.currentNode),
    pendingCheckpoint: obj(input.pendingCheckpoint),
    // A map of the workflow's input variables for a UI-started run
    // (`buildInputPreview`), a plain string for an agent run. Both shapes
    // reach here, so coercing to a string alone would silently store null.
    inputPreview: obj(input.inputPreview) || str(input.inputPreview),
    models: Array.isArray(input.models) ? [...input.models] : [],
    triggeredBy: obj(input.triggeredBy),
    archived: input.archived === true
  };
}

/**
 * Build the summary callers see from a stored document.
 *
 * @param {Object|null} doc - Document from the store.
 * @returns {Object|null} The summary, or null when there was no document.
 */
function toSummary(doc) {
  if (!doc || !doc.data || typeof doc.data !== 'object') return null;
  return { ...doc.data, runId: doc.key, ownerId: doc.data.ownerId ?? doc.ownerId ?? null };
}

/**
 * Apply a patch to a summary, protecting the fields identity depends on.
 *
 * @param {Object} summary - Stored summary.
 * @param {Object} fields - Fields to change.
 * @returns {Object} A new summary object, not yet normalized.
 */
function applyPatch(summary, fields) {
  const next = { ...summary };
  for (const [key, value] of Object.entries(fields || {})) {
    if (PROTECTED_FIELDS.has(key) || value === undefined) continue;
    next[key] = value;
  }
  next.updatedAt = str(fields?.updatedAt) || new Date().toISOString();
  return next;
}

/**
 * Order runs newest-first, breaking ties on the run id so paging is
 * deterministic. ISO-8601 timestamps compare correctly as strings, so this
 * never parses a date.
 *
 * @param {{startedAt?: string, runId: string}} a
 * @param {{startedAt?: string, runId: string}} b
 * @returns {number}
 */
function compareByStartedAtDesc(a, b) {
  const left = a.startedAt || '';
  const right = b.startedAt || '';
  if (left !== right) return left < right ? 1 : -1;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

/**
 * Whether a record passes the archived filter.
 *
 * Tri-state, mirroring what the execution listing has always done: the default
 * hides archived runs, `true`/`'only'` shows only those, and `'all'` shows
 * both.
 *
 * @param {Object} record - Run summary.
 * @param {boolean|'only'|'all'|undefined} archived - Requested filter.
 * @returns {boolean}
 */
function matchesArchived(record, archived) {
  if (archived === undefined || archived === null || archived === false) {
    return record.archived !== true;
  }
  if (archived === 'all') return true;
  return record.archived === true;
}

/**
 * Free-text match over the fields the admin execution list has always
 * searched: the owning principal, the workflow name in any language, and the
 * workflow id.
 *
 * @param {Object} record - Run summary.
 * @param {string} needle - Lower-cased search term.
 * @returns {boolean}
 */
function matchesSearch(record, needle) {
  const ownerId = (record.ownerId || '').toLowerCase();
  const workflowName =
    record.workflowName && typeof record.workflowName === 'object'
      ? Object.values(record.workflowName).join(' ').toLowerCase()
      : String(record.workflowName || '').toLowerCase();
  const workflowId = (record.workflowId || '').toLowerCase();
  return ownerId.includes(needle) || workflowName.includes(needle) || workflowId.includes(needle);
}

/**
 * Apply offset/limit the way the execution listing always has: an absent or
 * non-positive limit means "everything from the offset", never an empty page.
 *
 * @param {Object[]} items - Sorted records.
 * @param {unknown} limit - Requested page size.
 * @param {unknown} offset - Requested offset.
 * @returns {Object[]}
 */
function paginate(items, limit, offset) {
  const parsedOffset = Number(offset);
  const start = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;
  const parsedLimit = Number(limit);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) return items.slice(start);
  return items.slice(start, start + Math.floor(parsedLimit));
}

/**
 * Durable run summaries.
 */
export class RunSummaryRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null makes every method a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet. Optional: without it a read-modify-write still happens, it
   *   just loses its mutual exclusion — which is still strictly better than
   *   the whole-file rewrite it replaces, and refusing to record a run's
   *   status at all would be worse than either.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   */
  constructor({ documents = null, locks = null, logger: log } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.logger = log || logger;
  }

  /**
   * Whether this repository can store anything at all.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.documents);
  }

  /**
   * Whether an operation on this run can reach storage.
   *
   * @param {string} runId - Run id.
   * @param {string} operation - Method name, for the log line.
   * @returns {boolean}
   * @private
   */
  _usable(runId, operation) {
    if (!this.isAvailable()) return false;
    if (!isValidId(runId)) {
      this.logger.debug?.('Run id is not storable; skipping the run summary', {
        component: COMPONENT,
        operation,
        runId: String(runId).slice(0, 64)
      });
      return false;
    }
    return true;
  }

  /**
   * Run `fn` while holding this run's lock, or plainly when the provider has
   * no lock facet.
   *
   * @param {string} runId - Run id.
   * @param {() => Promise<T>} fn - Critical section.
   * @returns {Promise<T>}
   * @template T
   * @private
   */
  _withRunLock(runId, fn) {
    if (!this.locks) return Promise.resolve().then(fn);
    return this.locks.withLock(`run-summary:${runId}`, fn, LOCK_OPTIONS);
  }

  /**
   * Walk the namespace, optionally scoped to one owner, keeping the records
   * `match` accepts up to `max` of them.
   *
   * The predicate runs **inside** the scan, before the bound is counted,
   * because the `runs` namespace is shared by every run kind: an owner with a
   * thousand chat runs and five workflow executions would otherwise spend the
   * whole budget on documents the caller is about to discard, and its
   * executions — keyed `wf-exec-…`, which sorts after `chat-…` — would never
   * be loaded at all. So `max` bounds the matches and `maxExamined` bounds the
   * documents read, which is what still makes a pathological namespace
   * terminate.
   *
   * Truncation is reported so the caller can log it once with its own context
   * rather than guessing from a short result.
   *
   * @param {Object} [options]
   * @param {string|null} [options.ownerId=null] - Owner to scope to.
   * @param {number} [options.max=MAX_SCAN_RUNS] - Hard bound on matches kept.
   * @param {number} [options.maxExamined=MAX_EXAMINED_RUNS] - Hard bound on
   *   documents read.
   * @param {((record: Object) => boolean)|null} [options.match=null] - Keep
   *   only the records this accepts.
   * @returns {Promise<{records: Object[], truncated: boolean}>}
   * @private
   */
  async _load({
    ownerId = null,
    max = MAX_SCAN_RUNS,
    maxExamined = MAX_EXAMINED_RUNS,
    match = null
  } = {}) {
    const records = [];
    let examined = 0;

    // One enumeration for the whole namespace. Paging this with a cursor made
    // every page re-read and re-sort the entire directory, so a scan cost
    // O(N) per page — and `GET /api/agents/runs` reaches here from a plain
    // authenticated request, which made a namespace-sized scan something any
    // signed-in user could ask for repeatedly.
    if (this.documents.supportsScan) {
      let exhausted = true;
      for await (const doc of this.documents.scan(RUNS_NAMESPACE, {
        ...(ownerId ? { ownerId } : {})
      })) {
        examined += 1;
        const record = toSummary(doc);
        if (record && (!match || match(record))) records.push(record);
        if (records.length >= max || examined >= maxExamined) {
          exhausted = false;
          break;
        }
      }
      return { records, truncated: !exhausted };
    }

    // A provider that does not implement `scan` keeps the paged walk.
    let cursor = null;
    do {
      const page = await this.documents.list(RUNS_NAMESPACE, {
        limit: SCAN_PAGE_SIZE,
        ...(ownerId ? { ownerId } : {}),
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        examined += 1;
        const record = toSummary(doc);
        if (!record) continue;
        if (match && !match(record)) continue;
        records.push(record);
        if (records.length >= max) break;
      }
      cursor = page.nextCursor;
    } while (cursor && records.length < max && examined < maxExamined);
    return { records, truncated: Boolean(cursor) };
  }

  /**
   * Report a bound that cut a listing short. A capped listing that stayed
   * quiet would be read as a complete one.
   *
   * @param {string} operation - Method that truncated.
   * @param {Object} context - Extra log fields.
   * @private
   */
  _logTruncation(operation, context) {
    this.logger.warn('Run summary listing hit its scan bound and is incomplete', {
      component: COMPONENT,
      operation,
      ...context
    });
  }

  /**
   * One run's summary.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<Object|null>} The summary, or null when it does not
   *   exist or storage is unavailable.
   */
  async get(runId) {
    if (!this._usable(runId, 'get')) return null;
    return toSummary(await this.documents.get(RUNS_NAMESPACE, runId));
  }

  /**
   * Create or replace a run's summary.
   *
   * An anonymous run is stored **unowned**: its principal id is random and
   * exists for one run, so indexing it by owner would add a directory per run
   * to serve a listing that is forbidden by design. The record keeps its
   * `ownerId` field either way, so nothing downstream loses the principal.
   *
   * @param {Object} summary - Summary to store; see {@link RUN_SUMMARY_FIELDS}.
   * @returns {Promise<Object|null>} The stored summary, or null when it cannot
   *   be stored.
   */
  async put(summary) {
    const record = normalizeRunSummary(summary);
    if (!this._usable(record.runId, 'put')) return null;
    // Under the run's lock like every other mutator. A bare replace could
    // interleave with a concurrent `patch`/`merge` for the same run — the two
    // writers of an execution's summary, the ledger and the registry, do
    // exactly that at every workflow start — and erase what the other had
    // just merged in.
    return this._withRunLock(record.runId, async () => {
      const doc = await this.documents.put(RUNS_NAMESPACE, record.runId, record, {
        ownerId: record.anonymous ? null : record.ownerId
      });
      return toSummary(doc);
    });
  }

  /**
   * Create or merge a run's summary in one locked read-modify-write.
   *
   * This is the upsert both writers of an execution's summary use: the ledger
   * at `run/start` and {@link module:services/workflow/ExecutionRegistry} at
   * `register()`. They own disjoint halves of the record — the ledger has
   * `identityMode`, `parentRunId`, `refs` and `model`, the registry has
   * `workflowName`, `inputPreview`, `models` and `triggeredBy` — and both are
   * queued from synchronous callers onto independent chains, so neither can
   * assume it writes first. A create-or-replace would therefore drop the other
   * half whenever the two crossed; merging inside the lock means each writer
   * contributes only its own fields, in either order.
   *
   * @param {string} runId - Run id.
   * @param {Object} [fields] - Fields to write, on create and on merge alike.
   * @param {Object} [options]
   * @param {Object} [options.defaults] - Fields applied only when the summary
   *   is being created, for what is true of a new run and not of an update.
   * @returns {Promise<Object|null>} The stored summary, or null when the run
   *   id is not storable or storage is unavailable.
   */
  async merge(runId, fields = {}, { defaults = {} } = {}) {
    if (!this._usable(runId, 'merge')) return null;
    return this._withRunLock(runId, async () => {
      const existing = toSummary(await this.documents.get(RUNS_NAMESPACE, runId));
      const base = existing || { ...defaults, runId };
      const record = normalizeRunSummary(applyPatch(base, fields));
      const doc = await this.documents.put(RUNS_NAMESPACE, record.runId, record, {
        ownerId: record.anonymous ? null : record.ownerId
      });
      return toSummary(doc);
    });
  }

  /**
   * Merge `fields` into a run's summary under its lock.
   *
   * `runId` is immutable and ignored in the patch; `updatedAt` is stamped
   * unless the caller supplies one. A run with no summary is not created here
   * — a patch describes a change to something that started, and inventing a
   * record from a status update would store a run with no principal.
   *
   * @param {string} runId - Run id.
   * @param {Object} [fields] - Fields to change.
   * @returns {Promise<Object|null>} The stored summary, or null when the run
   *   has none or storage is unavailable.
   */
  async patch(runId, fields = {}) {
    if (!this._usable(runId, 'patch')) return null;
    return this._withRunLock(runId, async () => {
      const existing = toSummary(await this.documents.get(RUNS_NAMESPACE, runId));
      if (!existing) return null;
      const record = normalizeRunSummary(applyPatch(existing, fields));
      const doc = await this.documents.put(RUNS_NAMESPACE, runId, record, {
        ownerId: record.anonymous ? null : record.ownerId
      });
      return toSummary(doc);
    });
  }

  /**
   * Remove a run's summary.
   *
   * @param {string} runId - Run id.
   * @returns {Promise<boolean>} True when a summary was removed.
   */
  async remove(runId) {
    if (!this._usable(runId, 'remove')) return false;
    // Under the lock so a concurrent patch cannot read the record, lose the
    // race to the delete and write it back afterwards.
    return this._withRunLock(runId, () => this.documents.delete(RUNS_NAMESPACE, runId));
  }

  /**
   * One owner's runs, newest first.
   *
   * Anonymous runs are never returned, whatever the filters: their principal
   * is a per-run random id, and a listing keyed by it would be a listing of
   * one run the caller already has the id of.
   *
   * @param {string} ownerId - Owning principal id.
   * @param {Object} [filters]
   * @param {string} [filters.status] - Keep only this status.
   * @param {string} [filters.kind] - Keep only this run kind.
   * @param {boolean|'only'|'all'} [filters.archived] - Archived handling;
   *   default hides archived runs.
   * @param {number} [filters.limit] - Page size; absent means everything.
   * @param {number} [filters.offset] - Records to skip.
   * @param {(record: Object) => boolean} [filters.match] - Extra predicate,
   *   applied inside the scan like the rest so it shares the record bound
   *   instead of thinning an already-truncated page.
   * @returns {Promise<{items: Object[], total: number, truncated: boolean}>}
   *   The page, how many matched before paging, and whether the owner has more
   *   runs than the scan bound could load.
   */
  async listByOwner(ownerId, { status, kind, archived, limit, offset, match } = {}) {
    if (!this.isAvailable() || !ownerId) return { ...EMPTY_PAGE };
    const accept = record =>
      !record.anonymous &&
      (status ? record.status === status : true) &&
      (kind ? record.kind === kind : true) &&
      matchesArchived(record, archived) &&
      (match ? match(record) : true);
    const { records, truncated } = await this._load({
      ownerId: String(ownerId),
      max: MAX_OWNER_RUNS,
      match: accept
    });
    if (truncated) {
      this._logTruncation('listByOwner', { ownerId: String(ownerId), loaded: records.length });
    }
    const matched = records.sort(compareByStartedAtDesc);
    return { items: paginate(matched, limit, offset), total: matched.length, truncated };
  }

  /**
   * Every owner's runs, newest first — the admin listing.
   *
   * This scans the namespace: there is no cross-owner index, by design, since
   * an owner-scoped read is what the product does on every request and a
   * cross-owner one is what an administrator does occasionally. The scan is
   * bounded by {@link MAX_SCAN_RUNS} and logs when the bound cuts it short.
   *
   * Archived runs are included — the admin list has always shown them — and
   * anonymous runs are excluded, exactly as the ledger index listing was.
   *
   * @param {Object} [filters]
   * @param {string} [filters.status] - Keep only this status; `'all'` keeps
   *   every status.
   * @param {string} [filters.search] - Case-insensitive match on owner,
   *   workflow name or workflow id.
   * @param {number} [filters.limit] - Page size; absent means everything.
   * @param {number} [filters.offset] - Records to skip.
   * @param {boolean} [filters.includeAnonymous] - Include anonymous runs. Off
   *   for every listing; the retention sweep turns it on, because a run whose
   *   summary no listing may show is still a run whose data has to age out.
   * @param {(record: Object) => boolean} [filters.match] - Extra predicate,
   *   applied inside the scan so it shares the record bound.
   * @returns {Promise<{items: Object[], total: number, truncated: boolean}>}
   */
  async listAll({ status, search, limit, offset, includeAnonymous, match } = {}) {
    if (!this.isAvailable()) return { ...EMPTY_PAGE };
    const needle = typeof search === 'string' && search ? search.toLowerCase() : null;
    const accept = record =>
      (includeAnonymous === true || !record.anonymous) &&
      (status && status !== 'all' ? record.status === status : true) &&
      (needle ? matchesSearch(record, needle) : true) &&
      (match ? match(record) : true);
    const { records, truncated } = await this._load({ match: accept });
    if (truncated) this._logTruncation('listAll', { loaded: records.length });
    const matched = records.sort(compareByStartedAtDesc);
    return { items: paginate(matched, limit, offset), total: matched.length, truncated };
  }

  /**
   * Counts across the whole namespace, in the shape the admin overview reads.
   *
   * Anonymous runs are left out, so these numbers describe the same population
   * the listings do.
   *
   * @returns {Promise<{totalExecutions: number, totalUsers: number, byStatus: Object}>}
   */
  async stats() {
    const empty = { totalExecutions: 0, totalUsers: 0, byStatus: {} };
    if (!this.isAvailable()) return empty;
    const { records, truncated } = await this._load();
    if (truncated) this._logTruncation('stats', { loaded: records.length });
    const byStatus = {};
    const owners = new Set();
    let totalExecutions = 0;
    for (const record of records) {
      if (record.anonymous) continue;
      totalExecutions += 1;
      const status = record.status || 'unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (record.ownerId) owners.add(record.ownerId);
    }
    return { totalExecutions, totalUsers: owners.size, byStatus };
  }

  /**
   * Every run paused on a human checkpoint, newest first.
   *
   * @returns {Promise<Object[]>} Summaries awaiting human input.
   */
  async getPendingCheckpoints() {
    if (!this.isAvailable()) return [];
    const { records, truncated } = await this._load();
    if (truncated) this._logTruncation('getPendingCheckpoints', { loaded: records.length });
    return records
      .filter(record => record.status === 'paused' && record.pendingCheckpoint)
      .sort(compareByStartedAtDesc);
  }

  /**
   * Archive or unarchive a run.
   *
   * @param {string} runId - Run id.
   * @param {boolean} archived - New archive state.
   * @returns {Promise<Object|null>} The stored summary, or null when the run
   *   has none.
   */
  async setArchived(runId, archived) {
    return this.patch(runId, { archived: Boolean(archived) });
  }
}

/** @type {RunSummaryRepository|null} */
let cachedRepository = null;
/** @type {import('../../storage/StorageProvider.js').StorageProvider|null} */
let cachedProvider = null;

/**
 * Read a provider facet without letting a provider that does not implement it
 * throw out of the accessor — an unsupported facet is unavailable storage,
 * which the repository already knows how to be.
 *
 * @param {Object|null} provider - Storage provider.
 * @param {string} facet - Facet name.
 * @returns {Object|null}
 */
function readFacet(provider, facet) {
  try {
    return provider?.[facet] || null;
  } catch {
    return null;
  }
}

/**
 * The process-wide run summary repository over the bootstrapped storage
 * provider.
 *
 * Rebuilt when the provider changes (a test swapping one in, a shutdown
 * followed by a fresh bootstrap) and cheap enough to call per request. Before
 * storage is up it returns a repository whose every method is a no-op, so
 * callers never branch on initialization order.
 *
 * @returns {RunSummaryRepository}
 */
export function getRunSummaryRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new RunSummaryRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default RunSummaryRepository;
