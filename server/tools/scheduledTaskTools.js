/**
 * Scheduling tools — set up, inspect and change scheduled tasks from a chat.
 *
 *   schedule_task            propose a new task (confirmation card; nothing is saved)
 *   list_scheduled_tasks     the user's tasks with schedule, next run, last status
 *   update_scheduled_task    pause/resume directly; any other change is a proposal
 *   delete_scheduled_task    propose deleting a task (confirmation card)
 *   run_scheduled_task_now   start a run of an existing task
 *
 * Nothing that creates recurring work, changes what a task does or deletes
 * one happens on the model's word alone: content a tool fetched (a page, an
 * email, a ticket) could otherwise plant a task that keeps running as the
 * user. Those calls return a proposal the chat renders as a card, and only
 * the user's click on it calls the task API (see
 * `services/scheduler/tasks/proposals.js`).
 *
 * Inside a scheduled run (`user.scheduledRun`) a task may pause itself or
 * change its own schedule, and nothing else.
 *
 * Every failure is returned as `{ error: true, code, message }` so the model
 * can explain it or correct its call.
 *
 * @module tools/scheduledTaskTools
 */
import crypto from 'node:crypto';
import configCache from '../configCache.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import { getLocalizedString } from '../utils/localize.js';
import {
  describeSchedule,
  formatInstant,
  nextSlots,
  staggerOffsetMs
} from '../services/scheduler/schedule.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { logAudit } from '../services/AuditLogService.js';

/** Fields `update_scheduled_task` may change from inside a scheduled run. */
const SELF_UPDATE_FIELDS = ['schedule'];

function failure(error) {
  if (error instanceof tasks.ScheduledTaskError) {
    return {
      error: true,
      code: error.code,
      message: error.message,
      ...(Array.isArray(error.details) ? { details: error.details } : {})
    };
  }
  return {
    error: true,
    code: 'SCHEDULING_FAILED',
    message: error?.message || 'The request failed'
  };
}

/**
 * The audit entry a tool's change gets. The routes write theirs per request;
 * a change a tool applies directly has no request, so the user it acts for is
 * named as the actor.
 */
function audit(user, action, taskId, summary) {
  logAudit({ actor: user, action, resource: 'scheduledTask', resourceId: taskId, summary });
}

function refuse(code, message) {
  return { error: true, code, message };
}

function languageOf(language) {
  return typeof language === 'string' && language ? language : 'en';
}

function appName(appId, language) {
  const { data: apps = [] } = configCache.getApps() || {};
  const app = findByIdCaseInsensitive(apps, appId);
  return app ? getLocalizedString(app.name, language) || app.id : appId;
}

/**
 * The part of a task (or draft) a card and the model show: what runs, when.
 */
async function summarize(fields, { language, user, taskId, runCount = 0 }) {
  const { settings } = tasks.currentPolicy();
  const stagger = taskId ? staggerOffsetMs(taskId, settings.staggerMinutes) : 0;
  const zone = fields.schedule?.timezone || 'UTC';
  const upcoming = nextSlots(fields.schedule, { count: 5, runCount });
  let toolNames = null;
  if (Array.isArray(fields.enabledTools)) {
    const { data: apps = [] } = configCache.getApps() || {};
    const app = findByIdCaseInsensitive(apps, fields.appId);
    const offered = app ? await tasks.toolsOfferedByApp(app, user, language) : [];
    toolNames = fields.enabledTools.map(id => offered.find(tool => tool.id === id)?.name || id);
  }
  return {
    name: fields.name,
    description: fields.description || '',
    instructions: fields.instructions,
    appId: fields.appId,
    appName: appName(fields.appId, language),
    modelId: fields.modelId || null,
    schedule: fields.schedule,
    scheduleDescription: describeSchedule(fields.schedule, language),
    timezone: zone,
    nextRuns: upcoming.map(slot => new Date(slot.getTime() + stagger).toISOString()),
    nextRunsFormatted: upcoming.map(slot => formatInstant(slot, zone, language)),
    tools: toolNames,
    notify: fields.notify || 'always',
    staggerMinutes: settings.staggerMinutes
  };
}

function withinScheduledRun(user) {
  return Boolean(user?.scheduledRun?.taskId);
}

/**
 * Propose a new scheduled task.
 *
 * @param {Object} params - Model arguments plus the trusted `user`, `appConfig`, `chatId`,
 *   `language`, `clientTimezone`.
 * @returns {Promise<Object>}
 */
export async function scheduleTask(params = {}) {
  const { user, appConfig, chatId, clientTimezone } = params;
  const language = languageOf(params.language);
  if (withinScheduledRun(user)) {
    return refuse('NOT_AVAILABLE', 'A scheduled run cannot create further scheduled tasks');
  }
  try {
    const { settings } = tasks.assertAvailable();
    tasks.assertPrincipal(user);
    const draft = {
      name: params.name,
      description: params.description,
      instructions: params.instructions,
      appId: params.appId || appConfig?.id,
      modelId: params.modelId || null,
      enabledTools: Array.isArray(params.tools) ? params.tools : null,
      notify: params.notify || 'always',
      schedule: params.schedule || { type: 'manual' }
    };
    const fields = await tasks.validateTaskFields(draft, {
      user,
      settings,
      language,
      timezone: clientTimezone
    });
    const { id: ownerId } = await tasks.ownerIdentity(user);
    const existing = await getScheduledTaskRepository().listTasksByOwner(ownerId);
    if (settings.maxTasksPerUser > 0 && existing.length >= settings.maxTasksPerUser) {
      return refuse(
        'TASK_LIMIT_REACHED',
        `The user already has ${existing.length} scheduled tasks, the most allowed. They have to delete one first.`
      );
    }
    const summary = await summarize(fields, { language, user });
    return {
      status: 'proposed',
      saved: false,
      message:
        'Not saved yet. The user sees this task on a confirmation card with Save, Edit and Cancel; ' +
        'it is created only when they click Save. Summarize it in one or two sentences and ask ' +
        'them to review the card.',
      summary,
      scheduledTaskProposal: {
        proposalId: crypto.randomUUID(),
        action: 'create',
        draft: { ...fields, ...(chatId ? { sourceChatId: String(chatId) } : {}) },
        summary
      }
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The user's scheduled tasks.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function listScheduledTasks(params = {}) {
  const { user } = params;
  const language = languageOf(params.language);
  try {
    tasks.assertAvailable();
    const items = await tasks.listTasks(user, { language });
    return {
      count: items.length,
      tasks: items.map(task => ({
        taskId: task.id,
        name: task.name,
        status: task.status,
        ...(task.statusReason?.message ? { statusReason: task.statusReason.message } : {}),
        app: appName(task.appId, language),
        schedule: task.scheduleDescription,
        nextRun: task.nextRunAt || null,
        lastRun: task.lastRun
          ? {
              status: task.lastRun.status,
              at: task.lastRun.startedAt || task.lastRun.finishedAt,
              ...(task.lastRun.reason?.message ? { reason: task.lastRun.reason.message } : {})
            }
          : null,
        running: Boolean(task.activeRun),
        ...(withinScheduledRun(user) && user.scheduledRun.taskId === task.id
          ? { thisTask: true }
          : {})
      }))
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Change a task: pause or resume it at once, propose anything else.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function updateScheduledTask(params = {}) {
  const { user, clientTimezone } = params;
  const language = languageOf(params.language);
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  const inRun = withinScheduledRun(user);
  if (inRun && taskId !== user.scheduledRun.taskId) {
    return refuse('NOT_AVAILABLE', 'A scheduled run may only change its own task');
  }
  try {
    const { settings } = tasks.assertAvailable();
    const current = await tasks.getTask(user, taskId, { language });
    const changes = {};
    for (const key of ['name', 'description', 'instructions', 'schedule', 'notify', 'appId']) {
      if (params[key] !== undefined && params[key] !== null) changes[key] = params[key];
    }
    if (Array.isArray(params.tools)) changes.enabledTools = params.tools;
    const status = params.status;
    if (status !== undefined && status !== 'active' && status !== 'paused') {
      return refuse('INVALID_STATUS', 'status must be active or paused');
    }

    if (inRun) {
      if (status === 'active') {
        return refuse('NOT_AVAILABLE', 'A scheduled run cannot resume its own task');
      }
      const disallowed = Object.keys(changes).filter(key => !SELF_UPDATE_FIELDS.includes(key));
      if (disallowed.length > 0) {
        return refuse(
          'NOT_AVAILABLE',
          `A scheduled run may only change its own schedule or pause itself, not: ${disallowed.join(', ')}`
        );
      }
      let task = current;
      if (changes.schedule) {
        task = tasks.toPublicTask(
          await tasks.updateTask(user, taskId, changes, {
            language,
            timezone: clientTimezone,
            restrict: { fields: SELF_UPDATE_FIELDS }
          }),
          { language, settings }
        );
        audit(user, 'update', taskId, 'Changed the schedule of a scheduled task from its own run');
      }
      if (status === 'paused') {
        task = tasks.toPublicTask(await tasks.setTaskStatus(user, taskId, 'paused'), {
          language,
          settings
        });
        audit(user, 'toggle', taskId, 'Paused a scheduled task from its own run');
      }
      return {
        status: 'updated',
        taskId,
        taskStatus: task.status,
        schedule: task.scheduleDescription,
        nextRun: task.nextRunAt || null
      };
    }

    if (Object.keys(changes).length === 0) {
      if (!status) return refuse('NOTHING_TO_CHANGE', 'Name a change or a status');
      tasks.assertPrincipal(user);
      const task = await tasks.setTaskStatus(user, taskId, status);
      audit(
        user,
        'toggle',
        taskId,
        `${status === 'paused' ? 'Paused' : 'Resumed'} scheduled task from a chat`
      );
      return {
        status: 'updated',
        taskId,
        taskStatus: task.status,
        message: status === 'paused' ? 'The task is paused.' : 'The task is active again.'
      };
    }

    // A change to what the task does, when, or with which tools: proposed.
    tasks.assertPrincipal(user);
    const fields = await tasks.validateTaskFields(changes, {
      user,
      settings,
      previous: await getScheduledTaskRepository().getTask(taskId),
      language,
      timezone: clientTimezone
    });
    const summary = await summarize(fields, { language, user, taskId });
    return {
      status: 'proposed',
      saved: false,
      message:
        'Not changed yet. The user sees the change on a confirmation card and applies it with Save. ' +
        'Tell them what changes and ask them to review the card.',
      summary,
      scheduledTaskProposal: {
        proposalId: crypto.randomUUID(),
        action: 'update',
        taskId,
        draft: {
          ...changes,
          schedule: changes.schedule ? fields.schedule : undefined,
          ...(status ? { status } : {})
        },
        summary: {
          ...summary,
          before: {
            name: current.name,
            scheduleDescription: current.scheduleDescription,
            instructions: current.instructions
          },
          changedFields: Object.keys(changes)
        }
      }
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Propose deleting a task.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function deleteScheduledTask(params = {}) {
  const { user } = params;
  const language = languageOf(params.language);
  if (withinScheduledRun(user)) {
    return refuse('NOT_AVAILABLE', 'A scheduled run cannot delete scheduled tasks');
  }
  try {
    tasks.assertAvailable();
    const task = await tasks.getTask(user, String(params.taskId || ''), { language });
    const summary = {
      name: task.name,
      appId: task.appId,
      appName: appName(task.appId, language),
      scheduleDescription: task.scheduleDescription,
      instructions: task.instructions
    };
    return {
      status: 'proposed',
      saved: false,
      message:
        'Not deleted yet. The user confirms the deletion on a card in the chat. Tell them to confirm it there.',
      summary,
      scheduledTaskProposal: {
        proposalId: crypto.randomUUID(),
        action: 'delete',
        taskId: task.id,
        summary
      }
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Start a run of an existing task.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function runScheduledTaskNow(params = {}) {
  const { user } = params;
  if (withinScheduledRun(user)) {
    return refuse('NOT_AVAILABLE', 'A scheduled run cannot start other runs');
  }
  try {
    const run = await tasks.requestRun(user, String(params.taskId || ''));
    audit(user, 'execute', run.taskId, 'Started a scheduled task run from a chat');
    return {
      status: 'queued',
      taskId: run.taskId,
      runId: run.id,
      chatId: run.chatId,
      message:
        'The run is queued and starts within moments. Its result becomes its own chat, listed on the task in Tasks.'
    };
  } catch (error) {
    return failure(error);
  }
}

export default {
  scheduleTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  runScheduledTaskNow
};
