/**
 * The memory of a scheduled task, as the rest of the server uses it.
 *
 * Three callers share this module: the memory service (a run's `read_memory` /
 * `write_memory` tools and the prompt include), the HTTP routes (the owner
 * reads and edits, an admin sees metadata and clears) and the run itself (the
 * composer writes after a successful run). They all go through
 * {@link writeTaskMemory}, so every write keeps the summary on the task
 * document — size, version, last writer — which list views show without
 * reading the notes.
 *
 * Whether a task has memory at all is two switches: the platform setting
 * `scheduledTasks.memoryEnabled` and the task's own `memory.enabled`. The
 * notes are kept when either is switched off, but a run does not use them.
 *
 * @module services/scheduler/tasks/taskMemory
 */
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { getScheduledTaskRepository } from './ScheduledTaskRepository.js';
import { getTaskMemoryRepository, TaskMemoryError } from './TaskMemoryRepository.js';
import { scheduledTaskSettings } from './taskPolicy.js';

const COMPONENT = 'TaskMemory';

/** Memory scope kind of a scheduled task. */
export const MEMORY_SCOPE_TASK = 'scheduled-task';

/** What the prompt include appends when the notes were cut to fit. */
export const TRUNCATION_MARKER = '[notes truncated]';

/**
 * The memory settings in force.
 *
 * @param {Object} [platform]
 * @returns {{enabled: boolean, maxChars: number}}
 */
export function memorySettings(platform = configCache.getPlatform()) {
  const settings = scheduledTaskSettings(platform || {});
  return { enabled: settings.memoryEnabled, maxChars: settings.memoryMaxChars };
}

/**
 * Whether a run of this task uses memory: the platform allows it and the task
 * asked for it.
 *
 * @param {Object|null} task
 * @param {{enabled: boolean}} [settings]
 * @returns {boolean}
 */
export function isMemoryOn(task, settings = memorySettings()) {
  return Boolean(settings.enabled && task?.memory?.enabled === true);
}

/**
 * The notes of a task, shaped like any memory document.
 *
 * @param {Object} task
 * @returns {Promise<{body: string, version: number, updatedAt: string|null,
 *   updatedBy: string|null, summary: string|null, chars: number}>}
 */
export async function readTaskMemory(task) {
  const doc = await getTaskMemoryRepository().get(task.id, task.ownerId);
  return {
    body: doc.body || '',
    version: doc.version || 0,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || null,
    summary: doc.summary || null,
    chars: (doc.body || '').length
  };
}

/**
 * What an admin may know about a task's notes: that they exist, how big they
 * are, when they last changed and who wrote them — never what they say. The
 * shape has no field for the content, so it cannot leak by accident.
 *
 * @param {Object} task
 * @returns {Promise<{enabled: boolean, platformEnabled: boolean, version: number,
 *   chars: number, updatedAt: string|null, updatedBy: string|null}>}
 */
export async function taskMemoryMetadata(task) {
  const doc = await readTaskMemory(task);
  return {
    enabled: task.memory?.enabled === true,
    platformEnabled: memorySettings().enabled,
    version: doc.version,
    chars: doc.chars,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy
  };
}

/**
 * Write the notes of a task and keep the summary on the task document in step.
 *
 * @param {Object} task - The stored task document.
 * @param {Object} options - See {@link TaskMemoryRepository#write}. `maxChars` defaults
 *   to the platform's limit.
 * @returns {Promise<{version: number, body: string, chars: number, updatedAt: string}>}
 * @throws {TaskMemoryError}
 */
export async function writeTaskMemory(task, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : memorySettings().maxChars;
  const result = await getTaskMemoryRepository().write(task, { ...options, maxChars });
  const summary = {
    version: result.version,
    chars: result.chars,
    updatedAt: result.updatedAt,
    updatedBy: options.updatedBy || 'system'
  };
  try {
    await getScheduledTaskRepository().mutateTask(task.id, stored => {
      // Two writers can finish their note writes in one order and reach this
      // step in the other; the summary never goes back to an older version.
      if ((stored.memorySummary?.version ?? -1) >= summary.version) return null;
      stored.memorySummary = summary;
      return stored;
    });
  } catch (error) {
    // The notes are the source of truth; the summary is only for list views.
    logger.warn('Could not update the memory summary of a scheduled task', {
      component: COMPONENT,
      taskId: task.id,
      error: error.message
    });
  }
  return result;
}

/**
 * Clear the notes. The version goes up, so an editor that had them open sees a
 * conflict rather than silently bringing them back. Notes that are already
 * empty are left alone.
 *
 * @param {Object} task
 * @param {Object} [options]
 * @param {string} [options.updatedBy]
 * @returns {Promise<{version: number}>}
 */
export async function clearTaskMemory(task, { updatedBy } = {}) {
  const current = await readTaskMemory(task);
  if (current.body === '') return { version: current.version };
  const result = await writeTaskMemory(task, { mode: 'replace', content: '', updatedBy });
  return { version: result.version };
}

/**
 * The memory scope handler of scheduled tasks: what a run's own principal may
 * reach, which is exactly the notes of the task it is running for.
 *
 * @type {import('../../memory/memoryService.js').MemoryScopeHandler}
 */
export const taskMemoryHandler = {
  kind: MEMORY_SCOPE_TASK,

  async resolve(user) {
    const taskId = user?.scheduledRun?.taskId;
    if (!taskId) return null;
    const task = await getScheduledTaskRepository().getTask(taskId);
    if (!task || !isMemoryOn(task)) return null;
    return { kind: MEMORY_SCOPE_TASK, taskId: task.id, ownerId: task.ownerId };
  },

  async read(scope) {
    return readTaskMemory(await taskOf(scope));
  },

  async write(scope, { mode, content, summary, expectedVersion, updatedBy, maxChars }) {
    const task = await taskOf(scope);
    const result = await writeTaskMemory(task, {
      mode,
      content,
      summary,
      expectedVersion,
      updatedBy,
      maxChars
    });
    return { version: result.version, body: result.body, chars: result.chars };
  },

  async readForPrompt(scope, maxChars) {
    const doc = await readTaskMemory(await taskOf(scope));
    if (!doc.body || doc.body.trim().length === 0) return null;
    const limit = Number.isFinite(maxChars) ? maxChars : memorySettings().maxChars;
    if (doc.body.length <= limit) {
      return { body: doc.body, truncated: false, version: doc.version, updatedAt: doc.updatedAt };
    }
    return {
      body: `${doc.body.slice(0, limit)}\n\n${TRUNCATION_MARKER}`,
      truncated: true,
      version: doc.version,
      updatedAt: doc.updatedAt
    };
  }
};

async function taskOf(scope) {
  const task = await getScheduledTaskRepository().getTask(scope.taskId);
  if (!task || task.ownerId !== scope.ownerId) {
    throw new TaskMemoryError('TASK_NOT_FOUND', 'Scheduled task not found');
  }
  return task;
}
