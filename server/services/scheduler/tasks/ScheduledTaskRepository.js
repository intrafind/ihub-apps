/**
 * Durable storage for scheduled tasks and their runs.
 *
 * Tasks and runs are runtime user data, so they live on the storage provider
 * rather than in `contents/config`:
 *
 *   - `scheduled-tasks`     one document per task, keyed by task id, owned by
 *                           the task owner's principal id (the same id their
 *                           chats are owned by);
 *   - `scheduled-task-runs` one document per run, keyed
 *                           `<taskId>__<runId>` and owned by the same
 *                           principal, so a task's history is a prefix
 *                           listing and a user's history an owner listing.
 *
 * Run ids start with the inverted start time, so the ascending key order every
 * provider lists in is newest first — the order the history view pages in —
 * without a sort or an index of its own.
 *
 * Every read-modify-write goes through {@link ScheduledTaskRepository#mutateTask}
 * (or `mutateRun`): the task's lock plus a compare-and-set on its etag, because
 * the scheduler claiming a slot and the owner editing the task can meet on the
 * same document.
 *
 * @module services/scheduler/tasks/ScheduledTaskRepository
 */
import { randomUUID } from 'node:crypto';
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../../storage/namespaces.js';
import { EtagMismatchError } from '../../../storage/errors.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'ScheduledTaskRepository';

export const TASKS_NAMESPACE = RUNTIME_NAMESPACES.scheduledTasks;
export const RUNS_NAMESPACE = RUNTIME_NAMESPACES.scheduledTaskRuns;

/** Separator between the task id and the run id in a run key. */
const RUN_KEY_SEPARATOR = '__';
/** Largest timestamp an inverted run id can encode (year 2286). */
const MAX_TS = 9_999_999_999_999;
const LOCK_OPTIONS = { ttlMs: 15_000, waitMs: 5_000 };
/** Attempts a mutation makes when its compare-and-set loses. */
const MAX_CAS_ATTEMPTS = 3;
/** Largest page a run listing returns. */
export const MAX_RUN_PAGE = 100;

/**
 * A new task id: `st-` plus a UUID, safe as a storage key and in a URL.
 *
 * @returns {string}
 */
export function newTaskId() {
  return `st-${randomUUID()}`;
}

/**
 * A new run id, sortable newest first.
 *
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function newRunId(now = Date.now()) {
  const inverted = String(MAX_TS - Math.min(MAX_TS, Math.max(0, Math.floor(now)))).padStart(
    13,
    '0'
  );
  return `r${inverted}-${randomUUID().slice(0, 8)}`;
}

/**
 * Whether `id` has the shape of a task id.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isTaskId(id) {
  return typeof id === 'string' && /^st-[0-9a-f-]{36}$/.test(id);
}

/**
 * Whether `id` has the shape of a run id.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isRunId(id) {
  return typeof id === 'string' && /^r\d{13}-[0-9a-f]{8}$/.test(id);
}

/** The storage key of a run. */
export function runKey(taskId, runId) {
  return `${taskId}${RUN_KEY_SEPARATOR}${runId}`;
}

/** The task id and run id a run key encodes, or null. */
export function parseRunKey(key) {
  if (typeof key !== 'string') return null;
  const at = key.indexOf(RUN_KEY_SEPARATOR);
  if (at <= 0) return null;
  return { taskId: key.slice(0, at), runId: key.slice(at + RUN_KEY_SEPARATOR.length) };
}

export class ScheduledTaskRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {import('../../../storage/LockManager.js').LockManager|null} [options.locks]
   */
  constructor({ documents = null, locks = null } = {}) {
    this.documents = documents;
    this.locks = locks;
  }

  /** Whether this repository can store anything. */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  _require() {
    if (!this.isAvailable()) {
      const error = new Error('Scheduled task storage is not available');
      error.code = 'STORAGE_UNAVAILABLE';
      error.httpStatus = 503;
      throw error;
    }
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  /**
   * Read a task.
   *
   * @param {string} taskId
   * @returns {Promise<Object|null>}
   */
  async getTask(taskId) {
    if (!this.isAvailable() || !isValidId(taskId)) return null;
    const doc = await this.documents.get(TASKS_NAMESPACE, taskId);
    return doc?.data || null;
  }

  /**
   * Store a new task. Fails when the id is taken.
   *
   * @param {Object} task - Must carry `id` and `ownerId`.
   * @returns {Promise<Object>}
   */
  async createTask(task) {
    this._require();
    const doc = await this.documents.put(TASKS_NAMESPACE, task.id, task, {
      ownerId: task.ownerId,
      etag: null
    });
    return doc.data;
  }

  /**
   * Run `fn` holding the owner's lock: for the checks that span all of an
   * owner's tasks — the per-user limit, a proposal saved only once — which two
   * concurrent creates must not both pass. Not reentrant; `fn` must not take
   * it again.
   *
   * @param {string} ownerId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  async withOwnerLock(ownerId, fn) {
    this._require();
    return this.locks.withLock(`scheduled-task-owner:${ownerId}`, fn, LOCK_OPTIONS);
  }

  /**
   * Change a task under its lock.
   *
   * `fn` gets a copy of the stored task and returns the task to store, or
   * `null`/`undefined` to leave it as it is. A compare-and-set that loses to
   * a writer outside the lock is retried with a fresh read.
   *
   * @param {string} taskId
   * @param {(task: Object) => Object|null|undefined|Promise<Object|null|undefined>} fn
   * @returns {Promise<{task: Object|null, changed: boolean}>} `task` is null when it does not
   *   exist.
   */
  async mutateTask(taskId, fn) {
    this._require();
    if (!isValidId(taskId)) return { task: null, changed: false };
    return this.locks.withLock(
      `scheduled-task:${taskId}`,
      async () => {
        for (let attempt = 1; ; attempt++) {
          const doc = await this.documents.get(TASKS_NAMESPACE, taskId);
          if (!doc?.data) return { task: null, changed: false };
          const next = await fn(structuredClone(doc.data));
          if (!next) return { task: doc.data, changed: false };
          next.updatedAt = new Date().toISOString();
          try {
            const stored = await this.documents.put(TASKS_NAMESPACE, taskId, next, {
              ownerId: doc.ownerId || next.ownerId,
              etag: doc.etag
            });
            return { task: stored.data, changed: true };
          } catch (error) {
            if (!(error instanceof EtagMismatchError) || attempt >= MAX_CAS_ATTEMPTS) throw error;
          }
        }
      },
      LOCK_OPTIONS
    );
  }

  /**
   * Remove a task (not its runs; see {@link ScheduledTaskRepository#deleteRunsOfTask}).
   *
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  async deleteTask(taskId) {
    this._require();
    if (!isValidId(taskId)) return false;
    return this.locks.withLock(
      `scheduled-task:${taskId}`,
      () => this.documents.delete(TASKS_NAMESPACE, taskId),
      LOCK_OPTIONS
    );
  }

  /**
   * Every task one owner has.
   *
   * @param {string} ownerId
   * @returns {Promise<Object[]>}
   */
  async listTasksByOwner(ownerId) {
    if (!this.isAvailable() || typeof ownerId !== 'string' || !ownerId) return [];
    const out = [];
    for await (const doc of this._walk(TASKS_NAMESPACE, { ownerId })) {
      if (doc.data && doc.data.ownerId === ownerId) out.push(doc.data);
    }
    return out;
  }

  /**
   * Every task, one at a time — for the scheduler's index and the admin view.
   *
   * @yields {Object}
   */
  async *scanTasks() {
    if (!this.isAvailable()) return;
    for await (const doc of this._walk(TASKS_NAMESPACE, {})) {
      if (doc.data) yield doc.data;
    }
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  /**
   * Store a run.
   *
   * @param {Object} run - Must carry `id`, `taskId` and `ownerId`.
   * @returns {Promise<Object>}
   */
  async putRun(run) {
    this._require();
    const doc = await this.documents.put(RUNS_NAMESPACE, runKey(run.taskId, run.id), run, {
      ownerId: run.ownerId
    });
    return doc.data;
  }

  /**
   * Read a run.
   *
   * @param {string} taskId
   * @param {string} runId
   * @returns {Promise<Object|null>}
   */
  async getRun(taskId, runId) {
    if (!this.isAvailable() || !isValidId(taskId) || !isValidId(runId)) return null;
    const doc = await this.documents.get(RUNS_NAMESPACE, runKey(taskId, runId));
    return doc?.data || null;
  }

  /**
   * Change a run under its task's run lock.
   *
   * @param {string} taskId
   * @param {string} runId
   * @param {(run: Object) => Object|null|undefined} fn
   * @returns {Promise<Object|null>} The stored run, or null when it does not exist.
   */
  async mutateRun(taskId, runId, fn) {
    this._require();
    if (!isValidId(taskId) || !isValidId(runId)) return null;
    const key = runKey(taskId, runId);
    return this.locks.withLock(
      `scheduled-task-run:${key}`,
      async () => {
        const doc = await this.documents.get(RUNS_NAMESPACE, key);
        if (!doc?.data) return null;
        const next = await fn(structuredClone(doc.data));
        if (!next) return doc.data;
        const stored = await this.documents.put(RUNS_NAMESPACE, key, next, {
          ownerId: doc.ownerId || next.ownerId,
          etag: doc.etag
        });
        return stored.data;
      },
      LOCK_OPTIONS
    );
  }

  /**
   * One page of a task's runs, newest first.
   *
   * @param {string} taskId
   * @param {Object} [options]
   * @param {number} [options.limit=20]
   * @param {string|null} [options.cursor]
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   */
  async listRuns(taskId, { limit = 20, cursor = null } = {}) {
    if (!this.isAvailable() || !isValidId(taskId)) return { items: [], nextCursor: null };
    const size = Math.max(1, Math.min(MAX_RUN_PAGE, Math.floor(Number(limit)) || 20));
    const page = await this.documents.list(RUNS_NAMESPACE, {
      prefix: `${taskId}${RUN_KEY_SEPARATOR}`,
      limit: size,
      ...(cursor ? { cursor } : {})
    });
    return { items: page.items.map(doc => doc.data).filter(Boolean), nextCursor: page.nextCursor };
  }

  /**
   * Delete every run of a task.
   *
   * @param {string} taskId
   * @returns {Promise<Object[]>} The deleted runs (their chats may need deleting too).
   */
  async deleteRunsOfTask(taskId) {
    if (!this.isAvailable() || !isValidId(taskId)) return [];
    const removed = [];
    const keys = [];
    for await (const doc of this._walk(RUNS_NAMESPACE, {
      prefix: `${taskId}${RUN_KEY_SEPARATOR}`
    })) {
      keys.push(doc.key);
      if (doc.data) removed.push(doc.data);
    }
    for (const key of keys) {
      try {
        await this.documents.delete(RUNS_NAMESPACE, key);
      } catch (error) {
        logger.warn('Could not delete a scheduled task run', {
          component: COMPONENT,
          key,
          error: error.message
        });
      }
    }
    return removed;
  }

  /**
   * Delete one run document.
   *
   * @param {string} taskId
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async deleteRun(taskId, runId) {
    if (!this.isAvailable() || !isValidId(taskId) || !isValidId(runId)) return false;
    return this.documents.delete(RUNS_NAMESPACE, runKey(taskId, runId));
  }

  /**
   * Every run, one at a time — for the retention sweep.
   *
   * @yields {Object}
   */
  async *scanRuns() {
    if (!this.isAvailable()) return;
    for await (const doc of this._walk(RUNS_NAMESPACE, {})) {
      if (doc.data) yield doc.data;
    }
  }

  /**
   * Walk a namespace: the provider's single-pass scan when it has one, its
   * paged listing otherwise.
   *
   * @private
   */
  async *_walk(ns, { ownerId, prefix } = {}) {
    const filter = { ...(ownerId ? { ownerId } : {}), ...(prefix ? { prefix } : {}) };
    if (this.documents.supportsScan) {
      yield* this.documents.scan(ns, filter);
      return;
    }
    let cursor = null;
    do {
      const page = await this.documents.list(ns, {
        ...filter,
        limit: 500,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) yield doc;
      cursor = page.nextCursor;
    } while (cursor);
  }
}

let cachedProvider;
let cachedRepository = null;

/**
 * The repository over the running storage provider. Before storage is up it
 * is unavailable (`isAvailable() === false`) rather than missing.
 *
 * @returns {ScheduledTaskRepository}
 */
export function getScheduledTaskRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ScheduledTaskRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks')
    });
  }
  return cachedRepository;
}

/** Test hook: use this repository instead of the provider's. */
export function setScheduledTaskRepositoryForTests(repository) {
  cachedProvider = getStorage();
  cachedRepository = repository;
}

export default ScheduledTaskRepository;
