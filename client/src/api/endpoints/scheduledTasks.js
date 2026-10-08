import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * Scheduled tasks (`/api/scheduled-tasks/*`) — the caller's own tasks, their
 * runs, the schedule preview and the unseen-run notifications.
 *
 * Nothing here is cached: a task list changes whenever a run finishes, and a
 * stale one would show a run as still going. The routes answer `503
 * SCHEDULED_TASKS_UNAVAILABLE` when the feature is off, so callers gate on
 * `platformConfig.scheduledTasks.enabled` rather than probing.
 */

const base = '/scheduled-tasks';
const task = id => `${base}/${encodeURIComponent(id)}`;
const call = fn => handleApiResponse(fn, null, null);

/** The browser's IANA timezone, the default for a new schedule. */
export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** @returns {Promise<{items: Object[], limits: Object, canCreate: boolean}>} */
export const fetchScheduledTasks = () => call(() => apiClient.get(base));

/** @returns {Promise<Object>} */
export const fetchScheduledTask = taskId => call(() => apiClient.get(task(taskId)));

/**
 * Create a task.
 *
 * @param {Object} body - Task fields; `proposalId` when it came from a chat card.
 * @returns {Promise<Object>}
 */
export const createScheduledTask = body =>
  call(() => apiClient.post(base, { timezone: browserTimezone(), ...body }));

/** Edit a task (absent fields keep their value). */
export const updateScheduledTask = (taskId, body) =>
  call(() => apiClient.put(task(taskId), { timezone: browserTimezone(), ...body }));

/** Delete a task, optionally with its run chats. */
export const deleteScheduledTask = (taskId, { deleteChats = false } = {}) =>
  call(() => apiClient.delete(task(taskId), { params: deleteChats ? { deleteChats: 1 } : {} }));

export const runScheduledTaskNow = taskId => call(() => apiClient.post(`${task(taskId)}/run`));
export const pauseScheduledTask = taskId => call(() => apiClient.post(`${task(taskId)}/pause`));
export const resumeScheduledTask = taskId => call(() => apiClient.post(`${task(taskId)}/resume`));
export const duplicateScheduledTask = taskId =>
  call(() => apiClient.post(`${task(taskId)}/duplicate`));

/** A page of runs, newest first. */
export const fetchScheduledTaskRuns = (taskId, { limit = 20, cursor = null } = {}) =>
  call(() =>
    apiClient.get(`${task(taskId)}/runs`, { params: { limit, ...(cursor ? { cursor } : {}) } })
  );

export const fetchScheduledTaskRun = (taskId, runId) =>
  call(() => apiClient.get(`${task(taskId)}/runs/${encodeURIComponent(runId)}`));

export const cancelScheduledTaskRun = (taskId, runId) =>
  call(() => apiClient.post(`${task(taskId)}/runs/${encodeURIComponent(runId)}/cancel`));

/**
 * The notes a task keeps between runs, with their version and the limits.
 * Readable while memory is switched off: the notes are kept.
 *
 * @param {string} taskId
 * @returns {Promise<{enabled: boolean, platformEnabled: boolean, body: string, version: number,
 *   chars: number, maxChars: number, updatedAt: string|null, updatedBy: string|null}>}
 */
export const fetchScheduledTaskMemory = taskId =>
  call(() => apiClient.get(`${task(taskId)}/memory`));

/**
 * Replace a task's notes. A stale `expectedVersion` is a 409 `VERSION_CONFLICT`,
 * notes over the limit a 400 `MEMORY_TOO_LONG`.
 *
 * @param {string} taskId
 * @param {{content: string, expectedVersion?: number}} payload
 * @returns {Promise<{version: number, chars: number, updatedAt: string}>}
 */
export const writeScheduledTaskMemory = (taskId, { content, expectedVersion }) =>
  call(() => apiClient.put(`${task(taskId)}/memory`, { content, expectedVersion }));

/**
 * Clear a task's notes.
 *
 * @param {string} taskId
 * @returns {Promise<{version: number}>}
 */
export const deleteScheduledTaskMemory = taskId =>
  call(() => apiClient.delete(`${task(taskId)}/memory`));

/**
 * Answer the approval a run waits for.
 *
 * @param {string} taskId
 * @param {string} runId
 * @param {{decision: 'approve'|'reject', alwaysAllow?: boolean}} answer
 */
export const answerScheduledTaskApproval = (taskId, runId, answer) =>
  call(() => apiClient.post(`${task(taskId)}/runs/${encodeURIComponent(runId)}/approval`, answer));

export const revokeScheduledTaskTool = (taskId, toolId) =>
  call(() => apiClient.delete(`${task(taskId)}/allowed-tools/${encodeURIComponent(toolId)}`));

/**
 * Validate a schedule and get its description and next runs.
 *
 * @param {Object} schedule
 * @param {Object} [options]
 * @param {number} [options.count=5]
 * @returns {Promise<{schedule: Object, valid: boolean, errors: Object[], description: string,
 *   nextRuns: string[], nextRunsLocal: string[]}>}
 */
export const previewSchedule = (schedule, { count = 5 } = {}) =>
  call(() => apiClient.post(`${base}/_preview`, { schedule, count, timezone: browserTimezone() }));

/** Tools a task of this app may use. */
export const fetchScheduledTaskAppTools = appId =>
  call(() => apiClient.get(`${base}/_apps/${encodeURIComponent(appId)}/tools`));

/** Runs the caller has not seen yet. */
export const fetchScheduledTaskNotifications = () =>
  call(() => apiClient.get(`${base}/_notifications`));

/** Mark runs seen (all of them without `runIds`). */
export const markScheduledTaskNotificationsSeen = runIds =>
  call(() => apiClient.post(`${base}/_notifications/seen`, runIds ? { runIds } : {}));
