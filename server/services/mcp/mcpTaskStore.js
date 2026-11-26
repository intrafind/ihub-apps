// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tasks of the inbound MCP gateway (MCP Tasks extension,
 * `io.modelcontextprotocol/tasks`).
 *
 * An app or workflow run takes as long as its model calls take, often longer
 * than an MCP client keeps a request open. A client that declares the Tasks
 * extension therefore gets a task handle instead of waiting: the run goes on
 * in the background, and the client polls `tasks/get` until the task is
 * `completed` (the tool result), `failed` (a JSON-RPC error) or `cancelled`.
 *
 * Tasks are documents on the storage provider (`mcp-tasks`), owned by the
 * calling principal, so a poll that lands on another worker (or pod) finds the
 * task. The run itself stays on the worker that started it: its
 * AbortController is kept there, and a `tasks/cancel` that lands elsewhere is
 * relayed over the cluster bus. A finished run re-reads its task before it
 * records the outcome, so a cancel that won the race keeps the `cancelled`
 * state.
 *
 * @module services/mcp/mcpTaskStore
 */
import { randomUUID } from 'node:crypto';
import { requireStorage } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { publish, subscribe } from '../../clusterBus.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpTaskStore';

export const MCP_TASKS_NAMESPACE = RUNTIME_NAMESPACES.mcpTasks;

/**
 * How long a task is kept, counted from its creation: the longest run plus a
 * day to collect the result. Reported to clients as `ttlMs`.
 */
export const MCP_TASK_TTL_MS = 25 * 60 * 60 * 1000;

/** How often a client is asked to poll a running task. */
export const MCP_TASK_POLL_INTERVAL_MS = 5000;

/** Statuses after which a task no longer changes. */
export const FINAL_MCP_TASK_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

/** Tasks held in memory per worker (a fallback when storage fails). */
const MAX_MEMORY_ENTRIES = 2000;
/** Documents looked at per retention sweep. */
const SWEEP_PAGE_SIZE = 200;

const CANCEL_CHANNEL = 'mcp-task:cancel';

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isFinalMcpTaskStatus(status) {
  return FINAL_MCP_TASK_STATUSES.includes(status);
}

/**
 * The task as the Tasks extension shows it: what `tools/call` answers with
 * (`resultType: "task"` is added there) and what `tasks/get` returns, with the
 * tool result on `completed` and the JSON-RPC error on `failed`.
 *
 * @param {Object} record - A stored task
 * @returns {Object}
 */
export function taskWireShape(record) {
  return {
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage ? { statusMessage: record.statusMessage } : {}),
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttlMs: MCP_TASK_TTL_MS,
    ...(isFinalMcpTaskStatus(record.status) ? {} : { pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS }),
    ...(record.status === 'completed' && record.result ? { result: record.result } : {}),
    ...(record.status === 'failed' && record.error ? { error: record.error } : {})
  };
}

export class McpTaskStore {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore} [options.documents] -
   *   Document store; the storage provider's, resolved on first use, when omitted
   * @param {() => number} [options.now]
   * @param {boolean} [options.relayCancel=true] - Relay cancellations over the cluster bus
   */
  constructor({ documents, now = () => Date.now(), relayCancel = true } = {}) {
    this._documents = documents || null;
    this.now = now;
    /** @type {Map<string, Object>} this worker's copies, newest last */
    this.tasks = new Map();
    /** @type {Map<string, AbortController>} runs on this worker */
    this.runs = new Map();
    this._sweepCursor = null;
    this._unsubscribe = relayCancel
      ? subscribe(CANCEL_CHANNEL, payload => {
          if (typeof payload?.taskId === 'string') this.abortLocal(payload.taskId);
        })
      : null;
  }

  _docs() {
    return this._documents || requireStorage().documents;
  }

  /**
   * Create a task in status `working`.
   *
   * @param {Object} params
   * @param {string} params.ownerId - The calling principal; only it sees the task
   * @param {string} params.toolName - The tool the task runs
   * @param {string} [params.statusMessage]
   * @returns {Promise<Object>} The stored task
   */
  async create({ ownerId, toolName, statusMessage }) {
    const at = new Date(this.now()).toISOString();
    const record = {
      taskId: randomUUID(),
      ownerId,
      toolName,
      status: 'working',
      ...(statusMessage ? { statusMessage } : {}),
      createdAt: at,
      lastUpdatedAt: at
    };
    await this._save(record);
    return record;
  }

  /**
   * @param {string} taskId
   * @param {string} ownerId
   * @returns {Promise<Object|null>} The task, or null when unknown or someone else's
   */
  async get(taskId, ownerId) {
    const record = await this._load(taskId);
    return record?.ownerId === ownerId ? record : null;
  }

  /**
   * Record a finished run, unless the task reached a final status meanwhile
   * (a cancel).
   *
   * @param {string} taskId
   * @param {{result?: Object, error?: {code: number, message: string, data?: unknown}}} outcome
   * @returns {Promise<Object|null>}
   */
  async finish(taskId, { result, error }) {
    const record = await this._load(taskId);
    if (!record) return null;
    if (isFinalMcpTaskStatus(record.status)) return record;
    const updated = {
      ...record,
      status: error ? 'failed' : 'completed',
      lastUpdatedAt: new Date(this.now()).toISOString(),
      ...(error ? { error, statusMessage: error.message } : { result })
    };
    if (!error) delete updated.statusMessage;
    await this._save(updated);
    return updated;
  }

  /**
   * Cancel a task: abort its run here or ask the worker running it to, and
   * record `cancelled` so every worker sees it. A finished task stays as it is.
   *
   * @param {string} taskId
   * @param {string} ownerId
   * @returns {Promise<Object|null>} The task, or null when unknown or someone else's
   */
  async cancel(taskId, ownerId) {
    const record = await this.get(taskId, ownerId);
    if (!record) return null;
    if (isFinalMcpTaskStatus(record.status)) return record;
    if (!this.abortLocal(taskId)) publish(CANCEL_CHANNEL, { taskId });
    const updated = {
      ...record,
      status: 'cancelled',
      statusMessage: 'Cancelled by the client',
      lastUpdatedAt: new Date(this.now()).toISOString()
    };
    await this._save(updated);
    return updated;
  }

  /**
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
   * Abort a run on this worker.
   *
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

  async _load(taskId) {
    if (typeof taskId !== 'string' || !taskId) return null;
    try {
      const doc = await this._docs().get(MCP_TASKS_NAMESPACE, taskId);
      if (doc?.data?.taskId) {
        remember(this.tasks, taskId, doc.data);
        return doc.data;
      }
    } catch (error) {
      logger.warn("MCP task read failed; using this worker's copy", {
        component: COMPONENT,
        taskId,
        error: error.message
      });
    }
    return this.tasks.get(taskId) || null;
  }

  async _save(record) {
    remember(this.tasks, record.taskId, record);
    try {
      await this._docs().put(MCP_TASKS_NAMESPACE, record.taskId, record, {
        ownerId: record.ownerId
      });
    } catch (error) {
      logger.warn('MCP task write failed; the task is visible on this worker only', {
        component: COMPONENT,
        taskId: record.taskId,
        error: error.message
      });
    }
  }

  /**
   * Drop tasks past their time to live. Looks at one bounded page per call and
   * catches up over successive ticks.
   *
   * @returns {Promise<number>} How many tasks were removed
   */
  async sweep() {
    const now = this.now();
    let removed = 0;
    const expired = record => now - (Date.parse(record?.createdAt) || 0) > MCP_TASK_TTL_MS;
    for (const [id, record] of this.tasks) {
      if (expired(record)) this.tasks.delete(id);
    }
    try {
      const documents = this._docs();
      const page = await documents.list(MCP_TASKS_NAMESPACE, {
        limit: SWEEP_PAGE_SIZE,
        cursor: this._sweepCursor || undefined
      });
      for (const doc of page.items || []) {
        if (expired(doc.data) && (await documents.delete(MCP_TASKS_NAMESPACE, doc.key))) {
          removed += 1;
        }
      }
      this._sweepCursor = page.nextCursor || null;
    } catch (error) {
      this._sweepCursor = null;
      logger.warn('MCP task retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    }
    return removed;
  }

  /** Stop listening on the cluster bus (tests). */
  close() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }
}

/** Insert or refresh `key`, dropping the oldest entries past the cap. */
function remember(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_MEMORY_ENTRIES) map.delete(map.keys().next().value);
}

let singleton = null;

/**
 * The process-wide store of the gateway.
 * @returns {McpTaskStore}
 */
export function getMcpTaskStore() {
  if (!singleton) singleton = new McpTaskStore();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setMcpTaskStoreForTests(store) {
  singleton = store;
}
