// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files attached to a scheduled task (`scope: { type: 'task', id: taskId }`).
 *
 * They live as long as the task does (never swept by the age-based original
 * TTL) and are shown to the model in every run: a run chat references them
 * from the task scope, so the bytes are stored once however many runs there
 * are, and `pruneTaskRuns` never touches them.
 *
 * @module services/chatFiles/taskFiles
 */
import logger from '../../utils/logger.js';
import { getChatFileRepository } from './ChatFileRepository.js';
import { toPromptFileData } from './ChatFileService.js';

const COMPONENT = 'TaskFiles';

/** Most characters of task file text put into one run's prompt. */
export const MAX_TASK_FILE_PROMPT_CHARS = 400_000;

/**
 * The scope of a task's files.
 *
 * @param {string} taskId
 * @returns {{type: 'task', id: string}}
 */
export function taskFileScope(taskId) {
  return { type: 'task', id: taskId };
}

/**
 * Load a task's files as prompt `fileData`, oldest first, within a character
 * budget (what does not fit is cut with a note, the file stays listed).
 *
 * Never throws: a task whose files cannot be read still runs, without them.
 *
 * @param {string} taskId
 * @param {Object} [options]
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [options.repository]
 * @param {number} [options.maxChars]
 * @returns {Promise<Array<Object>>}
 */
export async function loadTaskPromptFiles(
  taskId,
  { repository = null, maxChars = MAX_TASK_FILE_PROMPT_CHARS } = {}
) {
  const repo = repository || getChatFileRepository();
  if (!taskId || !repo?.isAvailable?.()) return [];
  try {
    const scope = taskFileScope(taskId);
    const listed = (await repo.list(scope)).reverse();
    const files = [];
    let remaining = maxChars;
    for (const item of listed) {
      const stored = await repo.getText(scope, item.id);
      if (!stored) continue;
      const data = toPromptFileData(stored);
      if (typeof data.content === 'string' && data.content.length > remaining) {
        data.content =
          remaining > 0
            ? `${data.content.slice(0, remaining)}\n\n[… truncated: the task's files are larger than one run's prompt budget]`
            : "[Omitted: the task's files are larger than one run's prompt budget]";
      }
      remaining = Math.max(0, remaining - (data.content?.length || 0));
      files.push({ ...data, origin: 'upload', taskFile: true });
    }
    return files;
  } catch (error) {
    logger.warn('Could not load the files of a scheduled task; running without them', {
      component: COMPONENT,
      taskId,
      error: error.message
    });
    return [];
  }
}

/**
 * Put task files on the first user message of a run's messages, so the run
 * sees them on every turn (also when it continues after an approval).
 *
 * @param {Array<Object>} messages
 * @param {Array<Object>} files - From {@link loadTaskPromptFiles}.
 * @returns {Array<Object>} A new list; `messages` is not changed.
 */
export function withTaskFiles(messages, files) {
  if (!Array.isArray(messages) || !files?.length) return messages;
  const index = messages.findIndex(message => message?.role === 'user');
  if (index < 0) return messages;
  return messages.map((message, i) => {
    if (i !== index) return message;
    const own = message.fileData ? [message.fileData].flat() : [];
    return { ...message, fileData: [...files, ...own] };
  });
}

/**
 * Delete every file of a task (task deleted).
 *
 * @param {string} taskId
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [repository]
 * @returns {Promise<number>} Files removed.
 */
export async function deleteTaskFiles(taskId, repository = null) {
  const repo = repository || getChatFileRepository();
  if (!taskId || !repo?.isAvailable?.()) return 0;
  try {
    return await repo.deleteScope(taskFileScope(taskId));
  } catch (error) {
    logger.warn('Could not delete the files of a scheduled task', {
      component: COMPONENT,
      taskId,
      error: error.message
    });
    return 0;
  }
}

/**
 * Copy a task's files to another task (task duplicated). Each copy is a new
 * file with its own blobs; one that cannot be copied (a quota) is skipped.
 *
 * @param {string} fromTaskId
 * @param {string} toTaskId
 * @param {Object} [options]
 * @param {string|null} [options.ownerId]
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [options.repository]
 * @returns {Promise<number>} Files copied.
 */
export async function copyTaskFiles(
  fromTaskId,
  toTaskId,
  { ownerId = null, repository = null } = {}
) {
  const repo = repository || getChatFileRepository();
  if (!fromTaskId || !toTaskId || !repo?.isAvailable?.()) return 0;
  const from = taskFileScope(fromTaskId);
  const to = taskFileScope(toTaskId);
  let copied = 0;
  try {
    for (const item of (await repo.list(from)).reverse()) {
      try {
        const text = await repo.getText(from, item.id);
        if (!text) continue;
        const original = item.hasOriginal ? await repo.getOriginal(from, item.id) : null;
        const stored = await repo.put(to, {
          ownerId,
          name: item.name,
          mimeType: item.mimeType,
          formatLabel: item.formatLabel,
          text: text.text,
          pageImages: text.pageImages || null,
          pages: item.pages,
          truncated: item.truncated === true,
          originalBuffer: original && !original.discarded ? original.data : null,
          origin: item.origin,
          storageMode: item.storageMode,
          ...(item.source ? { source: item.source } : {}),
          ...(item.meta ? { meta: item.meta } : {})
        });
        if (stored) copied += 1;
      } catch (error) {
        logger.warn('A task file could not be copied to the duplicated task', {
          component: COMPONENT,
          fromTaskId,
          toTaskId,
          fileId: item.id,
          error: error.message
        });
      }
    }
  } catch (error) {
    logger.warn('Could not copy the files of a scheduled task', {
      component: COMPONENT,
      fromTaskId,
      error: error.message
    });
  }
  return copied;
}
