/**
 * Reading the earlier runs of a task from inside one of its runs.
 *
 * A run that keeps memory gets two tools, `list_task_runs` and `get_task_run`.
 * What they read is what already exists: the run documents (status, time,
 * whether it reported something new) and the run's own chat. Nothing is copied
 * onto the run document, so there is no second store to keep in step and the
 * owner's later replies in that chat are part of what a run can see.
 *
 * Which task and which owner is never taken from the model: the caller passes
 * the task of the run that is asking, and a chat is read only after it has been
 * checked to belong to that task and that owner.
 *
 * The answer of a run is found through the run's ledger ids, not by position.
 * Every execution of a run (the first, and one per approval) has its own ledger
 * run id, and every stored message carries the one it was written under; the
 * owner's follow-ups in the chat have ids of their own. The answer is the last
 * assistant message written under the run's last ledger id.
 *
 * @module services/scheduler/tasks/runHistory
 */
import { getChatRepository } from '../../chat/ChatRepository.js';
import { MAX_RUN_PAGE } from './ScheduledTaskRepository.js';
import { SCHEDULED_TASK_ORIGIN } from './taskPolicy.js';
import * as tasks from './taskService.js';

/** Runs `list_task_runs` returns by default, and at most. */
export const DEFAULT_RUN_LIST = 5;
export const MAX_RUN_LIST = 20;

/** Pages of run documents `get_task_run` pages through to find a run number. */
const MAX_RUN_PAGES = 10;

/**
 * Cut a text to `max` characters and say that it was cut.
 *
 * @param {unknown} text
 * @param {number} max
 * @returns {{text: string, truncated: boolean}}
 */
export function clipText(text, max) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, max)}\n[cut: ${value.length - max} more characters]`,
    truncated: true
  };
}

/**
 * Whether the chat of a run can still be read, as far as the run document
 * knows. Optimistic: a chat deleted by its owner or by age retention does not
 * mark the run, so the chat is looked up when it is actually read.
 *
 * @param {Object} run
 * @returns {boolean}
 */
export function hasReadableChat(run) {
  return Boolean(run?.chatId && run.startedAt && !run.chatDeleted);
}

/**
 * A run as a tool returns it: what the model needs to pick one, never the
 * execution lease or other internals.
 *
 * @param {Object} run
 * @returns {Object}
 */
export function projectRun(run) {
  return {
    runNumber: Number.isInteger(run.runNumber) ? run.runNumber : null,
    status: run.status,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    reason: run.reason ? { code: run.reason.code, message: run.reason.message } : null,
    hasChat: hasReadableChat(run),
    changed: typeof run.memory?.changed === 'boolean' ? run.memory.changed : null
  };
}

/**
 * The earlier runs of a task, newest first, without the run that is asking.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} options
 * @param {number} [options.limit]
 * @param {string} options.currentRunId
 * @returns {Promise<Object[]>}
 */
export async function listEarlierRuns(user, taskId, { limit, currentRunId }) {
  const wanted = Math.min(
    MAX_RUN_LIST,
    Math.max(1, Number.isInteger(limit) ? limit : DEFAULT_RUN_LIST)
  );
  // One more than asked for: the run that is asking may be among them.
  const page = await tasks.listRuns(user, taskId, { limit: wanted + 1 });
  return page.items
    .filter(run => run.id !== currentRunId)
    .slice(0, wanted)
    .map(projectRun);
}

/**
 * The run document with this run number. There is no index by number, but run
 * documents list newest first and numbers fall as the listing goes on, so the
 * search stops as soon as a page goes below the number asked for.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {number} runNumber
 * @returns {Promise<Object|null>}
 */
export async function findRunByNumber(user, taskId, runNumber) {
  let cursor = null;
  for (let pages = 0; pages < MAX_RUN_PAGES; pages += 1) {
    const page = await tasks.listRuns(user, taskId, {
      limit: MAX_RUN_PAGE,
      ...(cursor ? { cursor } : {})
    });
    const found = page.items.find(run => run.runNumber === runNumber);
    if (found) return found;
    if (page.items.some(run => Number.isInteger(run.runNumber) && run.runNumber < runNumber)) {
      return null;
    }
    cursor = page.nextCursor;
    if (!cursor) return null;
  }
  return null;
}

function lastWhere(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return list[index];
  }
  return null;
}

/**
 * Which stored messages belong to a run, and which of them is its answer.
 *
 * `uncertain` is set when the run document has no ledger ids (the run crashed,
 * or was recovered as interrupted) and the first message's id had to stand in.
 *
 * @param {Object[]} messages - The chat's transcript.
 * @param {Object} run
 * @returns {{ledger: string[], own: Set<string>, uncertain: boolean, answer: Object|null,
 *   partial: boolean}}
 */
export function pickRunMessages(messages, run) {
  let ledger = Array.isArray(run.ledgerRunIds) ? run.ledgerRunIds.filter(Boolean) : [];
  let uncertain = false;
  if (ledger.length === 0) {
    const first = messages[0];
    if (first?.role === 'user' && first.runId) {
      ledger = [first.runId];
      uncertain = true;
    }
  }
  const own = new Set(ledger);
  let answer = null;
  // The last execution's answer; an earlier one only when it is all there is
  // (an execution that paused for an approval may have stored a partial one).
  for (let index = ledger.length - 1; index >= 0 && !answer; index -= 1) {
    answer = lastWhere(
      messages,
      message =>
        message.role === 'assistant' &&
        message.runId === ledger[index] &&
        typeof message.content === 'string' &&
        message.content.trim() !== ''
    );
  }
  const partial = Boolean(
    answer &&
    (answer.finishReason === 'clarification' || answer.runId !== ledger[ledger.length - 1])
  );
  return { ledger, own, uncertain, answer, partial };
}

/**
 * The messages `include: 'conversation'` returns, within a size budget: the
 * run's answer and everything said after it, without the task's own
 * instructions (the run has them already). When the budget is too small the
 * oldest messages go first and the answer stays.
 *
 * @param {Object[]} messages
 * @param {{own: Set<string>, answer: Object|null}} picked
 * @param {number} maxChars
 * @returns {{messages: Object[], omitted: number, truncated: boolean}}
 */
export function conversationWithin(messages, picked, maxChars) {
  const entries = messages
    .filter(message => !(message.role === 'user' && picked.own.has(message.runId)))
    .filter(message => typeof message.content === 'string' && message.content !== '')
    .map(message => ({
      id: message.id,
      isAnswer: message === picked.answer,
      role: message.role,
      from: picked.own.has(message.runId) ? 'run' : 'followup',
      ts: message.ts || null,
      content: message.content
    }));
  let total = entries.reduce((sum, entry) => sum + entry.content.length, 0);
  let omitted = 0;
  while (total > maxChars && entries.length > 1) {
    const index = entries.findIndex(entry => !entry.isAnswer);
    if (index < 0) break;
    total -= entries[index].content.length;
    entries.splice(index, 1);
    omitted += 1;
  }
  let truncated = false;
  if (total > maxChars && entries.length === 1) {
    const clipped = clipText(entries[0].content, maxChars);
    entries[0].content = clipped.text;
    truncated = clipped.truncated;
  }
  return {
    messages: entries.map(({ isAnswer: _isAnswer, id: _id, ...entry }) => entry),
    omitted,
    truncated
  };
}

/**
 * What `get_task_run` returns for one earlier run.
 *
 * @param {Object} user - The principal of the run that is asking.
 * @param {Object} options
 * @param {string} options.taskId - The task of the run that is asking.
 * @param {string} options.currentRunId - That run: it cannot read itself.
 * @param {number} options.runNumber
 * @param {'answer'|'conversation'} [options.include='answer']
 * @param {number} options.maxChars - The most one result may hold.
 * @returns {Promise<Object>} `{ found: false, code }` or `{ found: true, run }`. The text of a
 *   run only ever sits inside `run`.
 */
export async function readEarlierRun(
  user,
  { taskId, currentRunId, runNumber, include = 'answer', maxChars }
) {
  const task = await tasks.getTask(user, taskId);
  const run = await findRunByNumber(user, taskId, runNumber);
  if (!run) return { found: false, code: 'RUN_NOT_FOUND' };
  if (run.id === currentRunId) return { found: false, code: 'CURRENT_RUN' };

  const meta = projectRun(run);
  const none = note => ({ found: true, run: { ...meta, answer: null, note } });
  if (!hasReadableChat(run)) return none('NO_CHAT');

  const chats = getChatRepository();
  if (!chats.isAvailable()) return none('CHAT_STORAGE_UNAVAILABLE');
  const chat = await chats.getChat(run.chatId);
  if (!chat) return none('CHAT_DELETED');
  // The run document names the chat, but the chat has to agree: the same
  // owner, made for this task and this run.
  if (
    chat.ownerId !== task.ownerId ||
    chat.origin?.createdVia !== SCHEDULED_TASK_ORIGIN ||
    chat.origin?.taskId !== taskId ||
    chat.origin?.runId !== run.id
  ) {
    return { found: false, code: 'RUN_NOT_FOUND' };
  }

  // A read, not a view: nothing here marks the owner's unread chat as seen.
  const { messages } = await chats.getMessages(run.chatId);
  const picked = pickRunMessages(messages, run);
  const answer = picked.answer
    ? (() => {
        const clipped = clipText(picked.answer.content, maxChars);
        return {
          content: clipped.text,
          truncated: clipped.truncated,
          ts: picked.answer.ts || null,
          finishReason: picked.answer.finishReason ?? null,
          partial: picked.partial
        };
      })()
    : null;
  const followUps = messages.filter(
    message => message.role === 'user' && !picked.own.has(message.runId)
  ).length;

  const result = {
    ...meta,
    uncertain: picked.uncertain,
    answer,
    ownerReplies: followUps,
    note: answer ? null : 'ANSWER_NOT_STORED'
  };
  if (include === 'conversation') {
    const conversation = conversationWithin(messages, picked, maxChars);
    result.conversation = conversation.messages;
    result.omittedMessages = conversation.omitted;
    if (conversation.truncated) result.conversationTruncated = true;
  }
  return { found: true, run: result };
}
