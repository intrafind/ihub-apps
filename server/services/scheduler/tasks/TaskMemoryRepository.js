/**
 * Durable storage for the notes a scheduled task keeps between its runs.
 *
 * One document per task in the `scheduled-task-memory` namespace, keyed by the
 * task id and owned by the task owner's principal id, so it is removed with
 * the task and never reachable by another owner. The content lives only here:
 * the task document is returned to admins as it is, and admins must not read
 * the notes.
 *
 * The document is markdown with the same fields agent memory has — a body, a
 * version, who wrote it and when — and the same write rules: `append` or
 * `replace`, and an `expectedVersion` that turns a stale write into a
 * `VERSION_CONFLICT`. On top of that a task's notes have a size cap
 * (`MEMORY_TOO_LONG`), and a write only lands while the task still exists, so
 * a run that is still going when its task is deleted cannot bring the notes
 * back.
 *
 * Writes take their own lock (`scheduled-task-memory:<taskId>`), never the
 * task's: locks are not reentrant and the caller may hold the task lock.
 *
 * @module services/scheduler/tasks/TaskMemoryRepository
 */
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../../storage/namespaces.js';
import { EtagMismatchError } from '../../../storage/errors.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import { getScheduledTaskRepository } from './ScheduledTaskRepository.js';

export const MEMORY_NAMESPACE = RUNTIME_NAMESPACES.scheduledTaskMemory;

const LOCK_OPTIONS = { ttlMs: 15_000, waitMs: 5_000 };
/** Attempts a write makes when its compare-and-set loses to a writer outside the lock. */
const MAX_CAS_ATTEMPTS = 3;

/** An error with a stable code the tools and the routes map to their responses. */
export class TaskMemoryError extends Error {
  /**
   * @param {string} code - VERSION_CONFLICT | MEMORY_TOO_LONG | TASK_NOT_FOUND | STORAGE_UNAVAILABLE
   * @param {string} message
   * @param {Object} [extra] - `currentVersion`, `chars`, `maxChars`
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TaskMemoryError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * The body after a write, by the same rules agent memory uses: `append` puts
 * the new text on its own line after the old, `replace` swaps the body, and
 * either ends with exactly one newline.
 *
 * Replacing with nothing leaves nothing: that is how notes are cleared.
 *
 * @param {string} current
 * @param {'append'|'replace'} mode
 * @param {string} content
 * @returns {string}
 */
export function nextBody(current, mode, content) {
  if (mode === 'append') {
    return current ? `${current.replace(/\n*$/, '\n')}${content}\n` : `${content}\n`;
  }
  if (mode === 'replace') {
    if (content === '') return '';
    return content.endsWith('\n') ? content : `${content}\n`;
  }
  throw new Error(`Unsupported writeMemory mode: ${mode}`);
}

function emptyDocument(taskId, ownerId) {
  return {
    taskId,
    ownerId,
    body: '',
    version: 0,
    chars: 0,
    updatedAt: null,
    updatedBy: null,
    summary: null
  };
}

export class TaskMemoryRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {import('../../../storage/LockManager.js').LockManager|null} [options.locks]
   * @param {() => import('./ScheduledTaskRepository.js').ScheduledTaskRepository} [options.tasks]
   *   Where the existence check looks; injectable for tests.
   */
  constructor({ documents = null, locks = null, tasks = getScheduledTaskRepository } = {}) {
    this.documents = documents;
    this.locks = locks;
    this.tasks = tasks;
  }

  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  _require() {
    if (!this.isAvailable()) {
      throw new TaskMemoryError('STORAGE_UNAVAILABLE', 'Task memory storage is not available');
    }
  }

  /**
   * The notes of a task. A task that never wrote any has version 0 and an
   * empty body.
   *
   * @param {string} taskId
   * @param {string} [ownerId] - Used for the empty document only.
   * @returns {Promise<Object>}
   */
  async get(taskId, ownerId = null) {
    if (!this.isAvailable() || !isValidId(taskId)) return emptyDocument(taskId, ownerId);
    const doc = await this.documents.get(MEMORY_NAMESPACE, taskId);
    return doc?.data
      ? { ...emptyDocument(taskId, ownerId), ...doc.data }
      : emptyDocument(taskId, ownerId);
  }

  /**
   * Write the notes.
   *
   * @param {Object} task - The stored task document (id and owner).
   * @param {Object} options
   * @param {'append'|'replace'} [options.mode='replace']
   * @param {string} options.content
   * @param {string} [options.summary]
   * @param {number} [options.expectedVersion] - Fails with `VERSION_CONFLICT` when it is a
   *   number that is not the stored version.
   * @param {string} [options.updatedBy] - `run:<id>`, `compose:<id>`, `owner` or `admin`.
   * @param {number} [options.maxChars] - Fails with `MEMORY_TOO_LONG` above it.
   * @returns {Promise<{version: number, body: string, chars: number, updatedAt: string}>}
   * @throws {TaskMemoryError}
   */
  async write(
    task,
    { mode = 'replace', content = '', summary, expectedVersion, updatedBy, maxChars } = {}
  ) {
    this._require();
    const taskId = task?.id;
    if (!isValidId(taskId)) throw new TaskMemoryError('TASK_NOT_FOUND', 'Scheduled task not found');
    return this.locks.withLock(
      `scheduled-task-memory:${taskId}`,
      async () => {
        for (let attempt = 1; ; attempt++) {
          // The task has to exist when the write lands, not only when the run
          // started: a delete in between must not leave notes behind.
          const stored = await this.tasks().getTask(taskId);
          if (!stored) throw new TaskMemoryError('TASK_NOT_FOUND', 'Scheduled task not found');

          const doc = await this.documents.get(MEMORY_NAMESPACE, taskId);
          const current = doc?.data || emptyDocument(taskId, stored.ownerId);
          if (typeof expectedVersion === 'number' && expectedVersion !== current.version) {
            throw new TaskMemoryError(
              'VERSION_CONFLICT',
              `Memory version mismatch: expected ${expectedVersion}, found ${current.version}`,
              { currentVersion: current.version }
            );
          }
          const body = nextBody(current.body || '', mode, content);
          if (Number.isFinite(maxChars) && body.length > maxChars) {
            throw new TaskMemoryError(
              'MEMORY_TOO_LONG',
              `The notes would be ${body.length} characters; the limit is ${maxChars}`,
              { chars: body.length, maxChars }
            );
          }
          const next = {
            taskId,
            ownerId: stored.ownerId,
            body,
            version: current.version + 1,
            chars: body.length,
            updatedAt: new Date().toISOString(),
            updatedBy: updatedBy || 'system',
            summary: summary || null
          };
          try {
            const result = await this.documents.put(MEMORY_NAMESPACE, taskId, next, {
              ownerId: stored.ownerId,
              // First write creates; later ones compare-and-set.
              etag: doc ? doc.etag : null
            });
            return {
              version: result.data.version,
              body: result.data.body,
              chars: result.data.chars,
              updatedAt: result.data.updatedAt
            };
          } catch (error) {
            if (!(error instanceof EtagMismatchError) || attempt >= MAX_CAS_ATTEMPTS) throw error;
          }
        }
      },
      LOCK_OPTIONS
    );
  }

  /**
   * Remove a task's notes (the task is going away).
   *
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  async delete(taskId) {
    if (!this.isAvailable() || !isValidId(taskId)) return false;
    return this.locks.withLock(
      `scheduled-task-memory:${taskId}`,
      () => this.documents.delete(MEMORY_NAMESPACE, taskId),
      LOCK_OPTIONS
    );
  }

  /**
   * The ids of every task that has notes, for the sweep of orphans.
   *
   * @returns {AsyncGenerator<string>}
   */
  async *keys() {
    if (!this.isAvailable()) return;
    if (this.documents.supportsScan) {
      for await (const doc of this.documents.scan(MEMORY_NAMESPACE, {})) yield doc.key;
      return;
    }
    let cursor = null;
    do {
      const page = await this.documents.list(MEMORY_NAMESPACE, {
        limit: 500,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) yield doc.key;
      cursor = page.nextCursor;
    } while (cursor);
  }
}

let cachedProvider;
let cachedRepository = null;

/**
 * The repository over the running storage provider. Before storage is up it
 * is unavailable rather than missing.
 *
 * @returns {TaskMemoryRepository}
 */
export function getTaskMemoryRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new TaskMemoryRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks')
    });
  }
  return cachedRepository;
}

/** Test hook: use this repository instead of the provider's. */
export function setTaskMemoryRepositoryForTests(repository) {
  cachedProvider = getStorage();
  cachedRepository = repository;
}

export default TaskMemoryRepository;
