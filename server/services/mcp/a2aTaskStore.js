/**
 * Task and context store for the inbound A2A endpoint (`/a2a`).
 *
 * A2A 0.3 is task-oriented: `message/send` creates a Task the client can poll
 * with `tasks/get` and stop with `tasks/cancel`, and a `contextId` groups the
 * messages of one conversation. Both live here.
 *
 * Tasks and contexts are documents on the storage provider (`a2a-tasks`,
 * `a2a-contexts`), owned by the calling principal, with an in-memory copy for
 * the worker that runs the task. The document is what makes `tasks/get` work
 * on a worker other than the one that ran `message/send`; without a provider
 * the store is memory-only and tasks are visible on the worker that created
 * them.
 *
 * In-flight runs stay local: the AbortController of a running task is kept
 * per worker, and a cancel that lands elsewhere is relayed over the cluster
 * bus. A task that is cancelled while another worker still runs it keeps its
 * `canceled` state — the running worker re-reads the task before it records a
 * result and drops the result when the task was cancelled meanwhile.
 *
 * @module services/mcp/a2aTaskStore
 */
import { randomUUID } from 'crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { publish, subscribe } from '../../clusterBus.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'A2ATaskStore';

export const A2A_TASKS_NAMESPACE = RUNTIME_NAMESPACES.a2aTasks;
export const A2A_CONTEXTS_NAMESPACE = RUNTIME_NAMESPACES.a2aContexts;

/** Finished tasks are kept this long for `tasks/get`. */
export const TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Contexts nobody wrote to for this long are dropped. */
export const CONTEXT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Messages kept per context (the conversation an app continues). */
export const MAX_CONTEXT_HISTORY = 40;
/** Messages kept on a task's own `history`. */
export const MAX_TASK_HISTORY = 20;
/** Tasks / contexts held in memory per worker before the oldest are dropped. */
const MAX_MEMORY_ENTRIES = 5000;
/** Documents looked at per retention sweep. */
const SWEEP_PAGE_SIZE = 200;

/** Task states after which nothing changes any more. */
export const FINAL_TASK_STATES = Object.freeze(['completed', 'canceled', 'failed', 'rejected']);

const CANCEL_CHANNEL = 'a2a:cancel';

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isFinalTaskState(state) {
  return FINAL_TASK_STATES.includes(state);
}

/** Insert or refresh `key`, dropping the oldest entries past the cap. */
function remember(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_MEMORY_ENTRIES) {
    map.delete(map.keys().next().value);
  }
}

/**
 * @param {string} state
 * @param {Object} [message] - Agent message describing the status
 * @returns {{state: string, timestamp: string, message?: Object}}
 */
export function taskStatus(state, message) {
  return { state, timestamp: new Date().toISOString(), ...(message ? { message } : {}) };
}

export class A2aTaskStore {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents] -
   *   Document store to persist to. Passing `null` pins memory-only mode; leaving
   *   it out resolves the storage provider lazily on first use.
   * @param {() => number} [options.now]
   * @param {boolean} [options.relayCancel=true] - Relay cancellations over the cluster bus
   */
  constructor({ documents, now = () => Date.now(), relayCancel = true } = {}) {
    this._documents = documents;
    this._pinned = documents !== undefined;
    this.now = now;
    /** @type {Map<string, {task: Object, ownerId: string, skillId: string, updatedAt: number}>} */
    this.tasks = new Map();
    /** @type {Map<string, Object>} */
    this.contexts = new Map();
    /** @type {Map<string, AbortController>} tasks running on this worker */
    this.runs = new Map();
    this._unsubscribe = relayCancel
      ? subscribe(CANCEL_CHANNEL, payload => {
          const taskId = payload?.taskId;
          if (typeof taskId === 'string') this.abortLocal(taskId);
        })
      : null;
  }

  _docs() {
    if (this._pinned) return this._documents || null;
    return readFacet(getStorage(), 'documents');
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  /**
   * Create a task in state `submitted`.
   *
   * @param {Object} params
   * @param {string} params.ownerId - Calling principal
   * @param {string} params.skillId - iHub skill the task runs (`app__x`, `workflow__y`)
   * @param {string} [params.contextId] - Existing context, or a new one is minted
   * @param {Object} params.message - The user's A2A Message
   * @returns {Promise<Object>} The task as the protocol shows it
   */
  async createTask({ ownerId, skillId, contextId, message }) {
    const task = {
      id: randomUUID(),
      contextId: contextId || randomUUID(),
      kind: 'task',
      status: taskStatus('submitted'),
      artifacts: [],
      history: [message],
      metadata: { skillId }
    };
    await this._saveTask({ task, ownerId, skillId, updatedAt: this.now() });
    return task;
  }

  /**
   * @param {string} taskId
   * @param {string} ownerId - Only the owner sees the task
   * @returns {Promise<Object|null>}
   */
  async getTask(taskId, ownerId) {
    const entry = await this._loadTask(taskId);
    if (!entry || entry.ownerId !== ownerId) return null;
    return entry.task;
  }

  /**
   * Apply a change to a stored task and persist it.
   *
   * @param {string} taskId
   * @param {(task: Object) => void|false} mutate - Return `false` to leave the task as is
   * @returns {Promise<Object|null>} The updated task, or null when unknown
   */
  async updateTask(taskId, mutate) {
    const entry = await this._loadTask(taskId);
    if (!entry) return null;
    if (mutate(entry.task) === false) return entry.task;
    entry.updatedAt = this.now();
    await this._saveTask(entry);
    return entry.task;
  }

  /**
   * Move a task to `state` unless it already reached a final state.
   *
   * @param {string} taskId
   * @param {string} state
   * @param {Object} [message] - Agent message to attach to the status (and history)
   * @returns {Promise<Object|null>} The task, or null when unknown
   */
  async setStatus(taskId, state, message) {
    return this.updateTask(taskId, task => {
      if (isFinalTaskState(task.status?.state)) return false;
      task.status = taskStatus(state, message);
      if (message) task.history = [...(task.history || []), message].slice(-MAX_TASK_HISTORY);
    });
  }

  /**
   * Set the task's single response artifact (replacing any earlier one).
   *
   * @param {string} taskId
   * @param {Object} artifact - A2A Artifact
   * @returns {Promise<Object|null>}
   */
  async setArtifact(taskId, artifact) {
    return this.updateTask(taskId, task => {
      if (isFinalTaskState(task.status?.state)) return false;
      const others = (task.artifacts || []).filter(a => a.artifactId !== artifact.artifactId);
      task.artifacts = [...others, artifact];
    });
  }

  async _loadTask(taskId) {
    if (typeof taskId !== 'string' || !taskId) return null;
    const local = this.tasks.get(taskId);
    const documents = this._docs();
    if (!documents) return local || null;
    try {
      const doc = await documents.get(A2A_TASKS_NAMESPACE, taskId);
      if (doc?.data?.task) {
        const entry = doc.data;
        // A task this worker is still running has the freshest copy in memory
        // (artifact chunks are not persisted while it streams), unless another
        // worker moved it to a final state — a cancel — which wins.
        if (local && !isFinalTaskState(entry.task.status?.state)) return local;
        remember(this.tasks, taskId, entry);
        return entry;
      }
    } catch (error) {
      logger.warn('A2A task read failed; using in-memory copy', {
        component: COMPONENT,
        taskId,
        error: error.message
      });
    }
    return local || null;
  }

  async _saveTask(entry) {
    remember(this.tasks, entry.task.id, entry);
    const documents = this._docs();
    if (!documents) return;
    try {
      await documents.put(A2A_TASKS_NAMESPACE, entry.task.id, entry, { ownerId: entry.ownerId });
    } catch (error) {
      logger.warn('A2A task write failed; task is visible on this worker only', {
        component: COMPONENT,
        taskId: entry.task.id,
        error: error.message
      });
    }
  }

  // ── contexts ─────────────────────────────────────────────────────────────

  /**
   * @param {string} contextId
   * @param {string} ownerId
   * @returns {Promise<{contextId: string, ownerId: string, skillId: string, history: Object[], updatedAt: number}|null>}
   */
  async getContext(contextId, ownerId) {
    if (typeof contextId !== 'string' || !contextId) return null;
    let context = this.contexts.get(contextId) || null;
    const documents = this._docs();
    if (documents) {
      try {
        const doc = await documents.get(A2A_CONTEXTS_NAMESPACE, contextId);
        if (doc?.data?.contextId) {
          context = doc.data;
          remember(this.contexts, contextId, context);
        }
      } catch (error) {
        logger.warn('A2A context read failed; using in-memory copy', {
          component: COMPONENT,
          contextId,
          error: error.message
        });
      }
    }
    if (!context || context.ownerId !== ownerId) return null;
    return context;
  }

  /**
   * Record the messages of a finished exchange on its context.
   *
   * @param {Object} params
   * @param {string} params.contextId
   * @param {string} params.ownerId
   * @param {string} params.skillId
   * @param {Object[]} params.messages - Messages to append (user, then agent)
   * @returns {Promise<Object>} The stored context
   */
  async appendToContext({ contextId, ownerId, skillId, messages }) {
    const existing = (await this.getContext(contextId, ownerId)) || {
      contextId,
      ownerId,
      skillId,
      history: []
    };
    const context = {
      ...existing,
      skillId: existing.skillId || skillId,
      history: [...(existing.history || []), ...messages].slice(-MAX_CONTEXT_HISTORY),
      updatedAt: this.now()
    };
    remember(this.contexts, contextId, context);
    const documents = this._docs();
    if (documents) {
      try {
        await documents.put(A2A_CONTEXTS_NAMESPACE, contextId, context, { ownerId });
      } catch (error) {
        logger.warn('A2A context write failed; context is visible on this worker only', {
          component: COMPONENT,
          contextId,
          error: error.message
        });
      }
    }
    return context;
  }

  // ── in-flight runs ───────────────────────────────────────────────────────

  /**
   * Remember the controller of a task running on this worker.
   * @param {string} taskId
   * @param {AbortController} controller
   */
  registerRun(taskId, controller) {
    this.runs.set(taskId, controller);
  }

  /** @param {string} taskId */
  releaseRun(taskId) {
    this.runs.delete(taskId);
  }

  /**
   * Abort a task running on this worker.
   * @param {string} taskId
   * @returns {boolean} True when a local run was aborted
   */
  abortLocal(taskId) {
    const controller = this.runs.get(taskId);
    if (!controller) return false;
    this.runs.delete(taskId);
    try {
      controller.abort(new Error('Task cancelled'));
    } catch {
      /* already aborted */
    }
    return true;
  }

  /**
   * Cancel a task: abort it here or ask the worker running it to, and record
   * the `canceled` state so every worker sees it.
   *
   * @param {string} taskId
   * @param {string} ownerId
   * @returns {Promise<{task: Object|null, cancelable: boolean}>}
   */
  async cancelTask(taskId, ownerId) {
    const task = await this.getTask(taskId, ownerId);
    if (!task) return { task: null, cancelable: false };
    if (isFinalTaskState(task.status?.state)) return { task, cancelable: false };
    if (!this.abortLocal(taskId)) {
      publish(CANCEL_CHANNEL, { taskId });
    }
    const updated = await this.setStatus(taskId, 'canceled');
    return { task: updated || task, cancelable: true };
  }

  // ── retention ────────────────────────────────────────────────────────────

  /**
   * Drop finished tasks and idle contexts past their retention. Looks at one
   * bounded page of each namespace per call, so the sweep stays cheap and
   * catches up over successive ticks.
   *
   * @returns {Promise<{tasks: number, contexts: number}>} What was removed
   */
  async sweep() {
    const now = this.now();
    const removed = { tasks: 0, contexts: 0 };
    for (const [id, entry] of this.tasks) {
      if (now - entry.updatedAt > TASK_RETENTION_MS) {
        this.tasks.delete(id);
        removed.tasks += 1;
      }
    }
    for (const [id, context] of this.contexts) {
      if (now - (context.updatedAt || 0) > CONTEXT_RETENTION_MS) {
        this.contexts.delete(id);
        removed.contexts += 1;
      }
    }
    const documents = this._docs();
    if (!documents) return removed;
    try {
      const tasks = await documents.list(A2A_TASKS_NAMESPACE, { limit: SWEEP_PAGE_SIZE });
      for (const doc of tasks.items || []) {
        const updatedAt = doc.data?.updatedAt || Date.parse(doc.updatedAt) || 0;
        if (now - updatedAt > TASK_RETENTION_MS) {
          if (await documents.delete(A2A_TASKS_NAMESPACE, doc.key)) removed.tasks += 1;
        }
      }
      const contexts = await documents.list(A2A_CONTEXTS_NAMESPACE, { limit: SWEEP_PAGE_SIZE });
      for (const doc of contexts.items || []) {
        const updatedAt = doc.data?.updatedAt || Date.parse(doc.updatedAt) || 0;
        if (now - updatedAt > CONTEXT_RETENTION_MS) {
          if (await documents.delete(A2A_CONTEXTS_NAMESPACE, doc.key)) removed.contexts += 1;
        }
      }
    } catch (error) {
      logger.warn('A2A retention sweep failed', { component: COMPONENT, error: error.message });
    }
    return removed;
  }

  /** Stop listening on the cluster bus (tests). */
  close() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }
}

let singleton = null;

/**
 * The process-wide store the `/a2a` routes use.
 * @returns {A2aTaskStore}
 */
export function getA2aTaskStore() {
  if (!singleton) singleton = new A2aTaskStore();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setA2aTaskStoreForTests(store) {
  singleton = store;
}
