/**
 * Scheduled tasks — what the routes and the scheduling tools do with them.
 *
 * Every operation that acts for a user resolves the user's principal id (the
 * id their chats are owned by) and only ever touches tasks with that owner;
 * an id that belongs to someone else reads as not found. Validation lives
 * here too, so a task created from the form, from a confirmation card or by
 * an admin is held to the same rules.
 *
 * Nothing here runs a task. A run is requested by storing it (`queued`) and
 * announcing the change; the scheduler owner picks it up and executes it.
 *
 * @module services/scheduler/tasks/taskService
 */
import configCache from '../../../configCache.js';
import { canUserAccessResource } from '../../../utils/authorization.js';
import { findByIdCaseInsensitive } from '../../../utils/resourceLookup.js';
import { getLocalizedString } from '../../../utils/localize.js';
import logger from '../../../utils/logger.js';
import runLog from '../../loop/RunLog.js';
import { resolvePrincipal } from '../../loop/runIdentity.js';
import interactionService from '../../loop/InteractionService.js';
import { getChatRepository, normalizeChatVariables } from '../../chat/ChatRepository.js';
import { deleteChatWithCascade } from '../../chat/chatDeletion.js';
import { abortChatRequest } from '../../../sse.js';
import { getWorkflowStateRepository } from '../../workflow/WorkflowStateRepository.js';
import {
  describeSchedule,
  formatZonedIso,
  nextSlots,
  previewSchedule,
  staggerOffsetMs,
  isValidTimezone
} from '../schedule.js';
import {
  getScheduledTaskRepository,
  isRunId,
  isTaskId,
  newTaskId
} from './ScheduledTaskRepository.js';
import { TaskMemoryError, getTaskMemoryRepository } from './TaskMemoryRepository.js';
import {
  clearTaskMemory,
  readTaskMemory,
  taskMemoryMetadata,
  writeTaskMemory
} from './taskMemory.js';
import {
  NOTIFY_MODES,
  applyRunOutcome,
  attachQueuedRun,
  holdTask,
  isFinalRunStatus,
  newRunDocument,
  newTaskDocument,
  reasonOf,
  resumeTask,
  computeNextRun
} from './taskModel.js';
import { ownerSnapshot } from './ownerPrincipal.js';
import {
  checkTaskPrincipal,
  isScheduledTasksConfigured,
  scheduledTaskSettings
} from './taskPolicy.js';
import { announceTaskChanged } from './taskEvents.js';
import { SCHEDULING_TOOLS } from './toolGate.js';

const COMPONENT = 'ScheduledTaskService';

export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_TOOLS = 100;

/** An error the routes turn into an HTTP response and the tools into a result. */
export class ScheduledTaskError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ScheduledTaskError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const notFound = () => new ScheduledTaskError(404, 'TASK_NOT_FOUND', 'Scheduled task not found');

/** The live settings and gates. */
export function currentPolicy() {
  const platform = configCache.getPlatform() || {};
  const features = configCache.getFeatures() || {};
  return {
    platform,
    features,
    settings: scheduledTaskSettings(platform),
    configured: isScheduledTasksConfigured(features, platform)
  };
}

/**
 * Throw unless the feature is on and storage is up.
 *
 * @returns {ReturnType<typeof currentPolicy>}
 */
export function assertAvailable() {
  const policy = currentPolicy();
  if (!policy.configured) {
    throw new ScheduledTaskError(
      503,
      'SCHEDULED_TASKS_UNAVAILABLE',
      'Scheduled tasks are not available on this installation'
    );
  }
  if (!getScheduledTaskRepository().isAvailable()) {
    throw new ScheduledTaskError(503, 'STORAGE_UNAVAILABLE', 'Task storage is not available');
  }
  return policy;
}

/**
 * Throw unless `user` may own scheduled tasks.
 *
 * @param {Object} user
 */
export function assertPrincipal(user) {
  const check = checkTaskPrincipal(user);
  if (check.ok) return;
  if (check.code === 'AUTHENTICATION_REQUIRED') {
    throw new ScheduledTaskError(401, check.code, 'Sign in to use scheduled tasks');
  }
  throw new ScheduledTaskError(403, check.code, 'You are not allowed to use scheduled tasks');
}

/**
 * The principal id and identity mode `user`'s tasks (and their chats) are owned under.
 *
 * @param {Object} user
 * @returns {Promise<{id: string, mode: string}>}
 */
export async function ownerIdentity(user) {
  const mode = runLog.identityMode();
  const principal = await resolvePrincipal(user, { mode });
  return { id: principal.id, mode: principal.mode || mode };
}

async function loadOwnedTask(user, taskId) {
  if (!isTaskId(taskId)) throw notFound();
  const { id: ownerId } = await ownerIdentity(user);
  const task = await getScheduledTaskRepository().getTask(taskId);
  if (!task || task.ownerId !== ownerId) throw notFound();
  return { task, ownerId };
}

// ── validation ─────────────────────────────────────────────────────────────

function localizedName(value, language) {
  if (typeof value === 'string') return value;
  return getLocalizedString(value, language, configCache.getPlatform()?.defaultLanguage || 'en');
}

/**
 * The tool ids an app offers a user — what a task may narrow its tools to.
 *
 * @param {Object} app
 * @param {Object} user
 * @param {string} language
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function toolsOfferedByApp(app, user, language = 'en') {
  const { getToolsForApp } = await import('../../../toolLoader.js');
  const tools = await getToolsForApp(app, language, { user, language });
  const seen = new Set();
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    // The scheduling tools are not something a task picks for its own runs.
    if (!tool?.id || seen.has(tool.id) || SCHEDULING_TOOLS.has(tool.id)) continue;
    seen.add(tool.id);
    out.push({ id: tool.id, name: localizedName(tool.name, language) || tool.id });
  }
  return out;
}

function fieldError(field, code, message) {
  return { field, code, message };
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate and normalize the editable fields of a task.
 *
 * @param {Object} input - Request body.
 * @param {Object} options
 * @param {Object} options.user - Expanded owner principal.
 * @param {Object} options.settings
 * @param {Object} [options.previous] - The task being edited (absent fields keep its values).
 * @param {string} [options.language='en']
 * @param {string} [options.timezone] - Default timezone (the browser's).
 * @param {number} [options.now=Date.now()]
 * @returns {Promise<Object>} The validated fields.
 * @throws {ScheduledTaskError} 400 with `details` listing every problem.
 */
export async function validateTaskFields(
  input,
  { user, settings, previous = null, language = 'en', timezone, now = Date.now() }
) {
  const body = input && typeof input === 'object' ? input : {};
  const has = key => Object.hasOwn(body, key) && body[key] !== undefined;
  const errors = [];
  const out = {};

  out.name = has('name') ? trimmedString(body.name) : previous?.name || '';
  if (!out.name) errors.push(fieldError('name', 'REQUIRED', 'A name is required'));
  else if (out.name.length > MAX_NAME_LENGTH) {
    errors.push(fieldError('name', 'TOO_LONG', `Name is limited to ${MAX_NAME_LENGTH} characters`));
  }

  out.description = has('description')
    ? trimmedString(body.description)
    : previous?.description || '';
  if (out.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      fieldError(
        'description',
        'TOO_LONG',
        `Description is limited to ${MAX_DESCRIPTION_LENGTH} characters`
      )
    );
  }

  out.instructions = has('instructions')
    ? typeof body.instructions === 'string'
      ? body.instructions.trim()
      : ''
    : previous?.instructions || '';
  if (!out.instructions) {
    errors.push(fieldError('instructions', 'REQUIRED', 'Instructions are required'));
  } else if (out.instructions.length > settings.maxInstructionLength) {
    errors.push(
      fieldError(
        'instructions',
        'TOO_LONG',
        `Instructions are limited to ${settings.maxInstructionLength} characters`
      )
    );
  }

  // App
  const appId = has('appId') ? trimmedString(body.appId) : previous?.appId || '';
  const { data: apps = [] } = configCache.getApps() || {};
  const app = appId ? findByIdCaseInsensitive(apps, appId) : null;
  if (!appId) errors.push(fieldError('appId', 'REQUIRED', 'Pick an app'));
  else if (!app || app.enabled === false) {
    errors.push(fieldError('appId', 'APP_NOT_FOUND', 'The app does not exist or is disabled'));
  } else if (!canUserAccessResource(user, 'apps', app.id)) {
    errors.push(fieldError('appId', 'APP_NOT_ACCESSIBLE', 'You do not have access to this app'));
  }
  out.appId = app?.id || appId;

  // Model override
  const modelId = has('modelId') ? trimmedString(body.modelId) || null : previous?.modelId || null;
  if (modelId && app) {
    const { data: models = [] } = configCache.getModels() || {};
    const model = findByIdCaseInsensitive(models, modelId);
    if (app.disallowModelSelection) {
      errors.push(
        fieldError('modelId', 'MODEL_SELECTION_DISABLED', 'This app does not allow picking a model')
      );
    } else if (!model || model.enabled === false) {
      errors.push(fieldError('modelId', 'MODEL_NOT_FOUND', 'The model does not exist'));
    } else if (!canUserAccessResource(user, 'models', model.id)) {
      errors.push(
        fieldError('modelId', 'MODEL_NOT_ACCESSIBLE', 'You do not have access to this model')
      );
    } else if (Array.isArray(app.allowedModels) && app.allowedModels.length > 0) {
      if (!app.allowedModels.some(id => String(id).toLowerCase() === model.id.toLowerCase())) {
        errors.push(fieldError('modelId', 'MODEL_NOT_ALLOWED', 'The app does not use this model'));
      }
    }
    out.modelId = model?.id || modelId;
  } else {
    out.modelId = null;
  }

  // App variables
  const rawVariables = has('variables') ? body.variables : previous?.variables;
  out.variables = normalizeChatVariables(rawVariables) || null;
  if (app && Array.isArray(app.variables)) {
    const declared = new Set(app.variables.map(v => v.name));
    if (out.variables) {
      for (const name of Object.keys(out.variables)) {
        if (!declared.has(name)) delete out.variables[name];
      }
      if (Object.keys(out.variables).length === 0) out.variables = null;
    }
    for (const variable of app.variables) {
      if (!variable.required) continue;
      const value = out.variables?.[variable.name];
      if (value === undefined || value === '') {
        errors.push(
          fieldError(
            `variables.${variable.name}`,
            'REQUIRED',
            `The app needs a value for ${localizedName(variable.label, language) || variable.name}`
          )
        );
      }
    }
  } else {
    out.variables = null;
  }

  // Tool subset
  const rawTools = has('enabledTools') ? body.enabledTools : previous?.enabledTools;
  if (rawTools === null || rawTools === undefined) {
    out.enabledTools = null;
  } else if (!Array.isArray(rawTools) || rawTools.length > MAX_TOOLS) {
    errors.push(fieldError('enabledTools', 'INVALID', 'Tools must be a list of tool ids'));
    out.enabledTools = null;
  } else {
    const ids = [...new Set(rawTools.filter(id => typeof id === 'string' && id))];
    if (app) {
      const offered = new Set((await toolsOfferedByApp(app, user, language)).map(t => t.id));
      const unknown = ids.filter(id => !offered.has(id));
      if (unknown.length > 0) {
        errors.push(
          fieldError(
            'enabledTools',
            'TOOL_NOT_AVAILABLE',
            `The app does not offer: ${unknown.join(', ')}`
          )
        );
      }
    }
    out.enabledTools = ids;
  }

  out.websearchEnabled = has('websearchEnabled')
    ? typeof body.websearchEnabled === 'boolean'
      ? body.websearchEnabled
      : null
    : (previous?.websearchEnabled ?? null);

  // Memory between runs: a boolean or `{ enabled }`. An edit that does not
  // name it keeps what the task has.
  out.memory = has('memory')
    ? { enabled: (typeof body.memory === 'boolean' ? body.memory : body.memory?.enabled) === true }
    : { enabled: previous?.memory?.enabled === true };

  out.notify = has('notify') ? body.notify : previous?.notify || 'always';
  if (!NOTIFY_MODES.includes(out.notify)) {
    errors.push(
      fieldError('notify', 'INVALID', `Notify must be one of ${NOTIFY_MODES.join(', ')}`)
    );
  } else if (out.notify === 'changes' && !out.memory.enabled) {
    errors.push(
      fieldError(
        'notify',
        'NOTIFY_CHANGES_NEEDS_MEMORY',
        'Notifying only when something changed needs "Remember between runs"'
      )
    );
  }

  // Schedule
  const scheduleInput = has('schedule') ? body.schedule : previous?.schedule;
  const defaultZone =
    (isValidTimezone(timezone) && timezone) || previous?.schedule?.timezone || 'UTC';
  const preview = previewSchedule(scheduleInput || { type: 'manual' }, {
    timezone: defaultZone,
    minIntervalMinutes: settings.minIntervalMinutes,
    now,
    previous: previous?.schedule,
    // An unchanged one-time schedule that already fired is not an error on
    // an edit that only renames the task.
    requireFuture: !previous || has('schedule')
  });
  errors.push(...preview.errors);
  out.schedule = preview.schedule;

  if (errors.length > 0) {
    throw new ScheduledTaskError(400, 'INVALID_TASK', errors[0].message, errors);
  }
  return out;
}

// ── projection ─────────────────────────────────────────────────────────────

/**
 * A task as the API returns it: the document plus the derived views the
 * client shows (schedule in words, next runs).
 *
 * @param {Object} task
 * @param {Object} [options]
 * @param {string} [options.language='en']
 * @param {Object} [options.settings]
 * @param {boolean} [options.admin=false] - Include the owner's groups.
 * @param {number} [options.now]
 * @returns {Object}
 */
export function toPublicTask(task, { language = 'en', settings, admin = false, now } = {}) {
  const cfg = settings || currentPolicy().settings;
  const stagger = staggerOffsetMs(task.id, cfg.staggerMinutes);
  const upcoming =
    task.status === 'active' && task.nextSlotAt
      ? nextSlots(task.schedule, {
          count: 3,
          after: Date.parse(task.nextSlotAt) - 1,
          runCount: task.scheduledRunCount || 0
        }).map(slot => new Date(slot.getTime() + stagger).toISOString())
      : [];
  const { owner, ...rest } = task;
  return {
    ...rest,
    owner: owner
      ? {
          userId: owner.userId,
          username: owner.username,
          name: owner.name,
          ...(admin ? { email: owner.email, groups: owner.groups, authMode: owner.authMode } : {})
        }
      : null,
    scheduleDescription: describeSchedule(task.schedule, language),
    upcomingRuns: upcoming,
    staggerMinutes: cfg.staggerMinutes,
    unseenCount: Array.isArray(task.unseenRuns) ? task.unseenRuns.length : 0,
    ...(now ? { generatedAt: new Date(now).toISOString() } : {})
  };
}

// ── user operations ─────────────────────────────────────────────────────────

/**
 * The caller's tasks, newest first.
 *
 * @param {Object} user
 * @param {Object} [options]
 * @param {string} [options.language]
 * @returns {Promise<Object[]>}
 */
export async function listTasks(user, { language = 'en' } = {}) {
  const { settings } = assertAvailable();
  const { id: ownerId } = await ownerIdentity(user);
  const tasks = await getScheduledTaskRepository().listTasksByOwner(ownerId);
  tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return tasks.map(task => toPublicTask(task, { language, settings }));
}

/**
 * One of the caller's tasks.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function getTask(user, taskId, { language = 'en' } = {}) {
  const { settings } = assertAvailable();
  const { task } = await loadOwnedTask(user, taskId);
  return toPublicTask(task, { language, settings });
}

/**
 * Create a task.
 *
 * @param {Object} user - Expanded principal.
 * @param {Object} input
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {string} [options.timezone]
 * @param {'ui'|'tool'|'duplicate'|'admin'} [options.createdVia='ui']
 * @param {string} [options.proposalId] - The confirmation card this came from; saving
 *   the same card twice is refused.
 * @param {string} [options.sourceChatId]
 * @returns {Promise<Object>} The stored task (raw document).
 */
export async function createTask(
  user,
  input,
  { language = 'en', timezone, createdVia = 'ui', proposalId, sourceChatId } = {}
) {
  const { settings } = assertAvailable();
  assertPrincipal(user);
  const now = Date.now();
  const fields = await validateTaskFields(input, { user, settings, language, timezone, now });
  const identity = await ownerIdentity(user);
  const repository = getScheduledTaskRepository();
  const cleanProposalId =
    typeof proposalId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(proposalId) ? proposalId : null;
  // The limit and the proposal check read all of the owner's tasks: under the
  // owner's lock, so two saves at once (a double click, two tabs) cannot both
  // pass them.
  const stored = await repository.withOwnerLock(identity.id, async () => {
    const existing = await repository.listTasksByOwner(identity.id);
    if (settings.maxTasksPerUser > 0 && existing.length >= settings.maxTasksPerUser) {
      throw new ScheduledTaskError(
        409,
        'TASK_LIMIT_REACHED',
        `You can have at most ${settings.maxTasksPerUser} scheduled tasks`
      );
    }
    if (cleanProposalId) {
      const saved = existing.find(task => task.proposalId === cleanProposalId);
      if (saved) {
        throw new ScheduledTaskError(409, 'PROPOSAL_ALREADY_SAVED', 'This task was already saved', {
          taskId: saved.id
        });
      }
    }
    const task = newTaskDocument(fields, {
      id: newTaskId(),
      ownerId: identity.id,
      owner: ownerSnapshot(user, identity.mode),
      now,
      staggerMinutes: settings.staggerMinutes,
      createdVia,
      extra: {
        ...(cleanProposalId ? { proposalId: cleanProposalId } : {}),
        ...(typeof sourceChatId === 'string' && sourceChatId.length <= 100 ? { sourceChatId } : {})
      }
    });
    return repository.createTask(task);
  });
  announceTaskChanged(stored.id);
  logger.info('Scheduled task created', {
    component: COMPONENT,
    taskId: stored.id,
    appId: stored.appId,
    scheduleType: stored.schedule.type,
    createdVia
  });
  return stored;
}

/**
 * Edit a task. Absent fields keep their values; the owner snapshot is
 * refreshed from the editing user, so the task runs with their current groups.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} input
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {string} [options.timezone]
 * @param {Object} [options.restrict] - `{ fields: string[] }`: only these may change (tools
 *   inside a scheduled run).
 * @returns {Promise<Object>} The stored task.
 */
export async function updateTask(
  user,
  taskId,
  input,
  { language = 'en', timezone, restrict } = {}
) {
  const { settings } = assertAvailable();
  assertPrincipal(user);
  const { task: current, ownerId } = await loadOwnedTask(user, taskId);
  const body = input && typeof input === 'object' ? { ...input } : {};
  if (restrict?.fields) {
    for (const key of Object.keys(body)) if (!restrict.fields.includes(key)) delete body[key];
  }
  const now = Date.now();
  const fields = await validateTaskFields(body, {
    user,
    settings,
    previous: current,
    language,
    timezone,
    now
  });
  const identity = await ownerIdentity(user);
  const { task } = await getScheduledTaskRepository().mutateTask(taskId, stored => {
    if (stored.ownerId !== ownerId) throw notFound();
    const scheduleChanged = JSON.stringify(stored.schedule) !== JSON.stringify(fields.schedule);
    Object.assign(stored, fields);
    stored.owner = ownerSnapshot(user, identity.mode);
    if (scheduleChanged) {
      // A new schedule starts over: its max-runs count from now on.
      stored.scheduledRunCount = 0;
      if (stored.status === 'completed') {
        stored.status = 'active';
        stored.statusReason = null;
      }
    }
    if (stored.status === 'active') {
      Object.assign(
        stored,
        computeNextRun(stored, { after: now, staggerMinutes: settings.staggerMinutes })
      );
      if (stored.schedule.type !== 'manual' && !stored.nextRunAt && !stored.activeRun) {
        holdTask(
          stored,
          'completed',
          reasonOf('NO_FUTURE_RUNS', 'The schedule has no future runs', now)
        );
      }
    }
    return stored;
  });
  if (!task) throw notFound();
  announceTaskChanged(taskId);
  return task;
}

/**
 * Pause or resume a task.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {'paused'|'active'} status
 * @returns {Promise<Object>}
 */
export async function setTaskStatus(user, taskId, status) {
  const { settings } = assertAvailable();
  // Pausing stops work the owner already has, like deleting it: allowed
  // after the permission was withdrawn. Resuming starts it again, so it is not.
  if (status !== 'paused') assertPrincipal(user);
  const { ownerId } = await loadOwnedTask(user, taskId);
  const now = Date.now();
  const { task } = await getScheduledTaskRepository().mutateTask(taskId, stored => {
    if (stored.ownerId !== ownerId) throw notFound();
    if (stored.status === 'disabled') {
      throw new ScheduledTaskError(
        409,
        'TASK_DISABLED',
        stored.statusReason?.message || 'This task is disabled and cannot run'
      );
    }
    if (status === 'paused') {
      if (stored.status === 'paused') return null;
      holdTask(stored, 'paused', reasonOf('PAUSED_BY_OWNER', 'Paused by the owner', now));
      return stored;
    }
    if (stored.status === 'active') return null;
    resumeTask(stored, { now, staggerMinutes: settings.staggerMinutes });
    return stored;
  });
  if (!task) throw notFound();
  announceTaskChanged(taskId);
  return task;
}

/**
 * Copy a task (active, with no history).
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function duplicateTask(user, taskId, { language = 'en' } = {}) {
  const { task } = await loadOwnedTask(user, taskId);
  const suffix = language.startsWith('de') ? ' (Kopie)' : ' (copy)';
  const schedule = { ...task.schedule };
  delete schedule.anchorAt;
  return createTask(
    user,
    {
      name: `${task.name}`.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix,
      description: task.description,
      instructions: task.instructions,
      appId: task.appId,
      modelId: task.modelId,
      variables: task.variables,
      enabledTools: task.enabledTools,
      websearchEnabled: task.websearchEnabled,
      // The setting, not the notes: the copy starts with its own first run.
      memory: task.memory,
      schedule: schedule.type === 'once' ? { type: 'manual' } : schedule,
      notify: task.notify
    },
    { language, createdVia: 'duplicate' }
  );
}

/**
 * Stop whatever run a task has in flight.
 *
 * @param {Object} task
 * @param {string} reasonCode
 * @param {string} message
 * @returns {Promise<void>}
 */
async function stopActiveRun(task, reasonCode, message) {
  const active = task.activeRun;
  if (!active) return;
  const repository = getScheduledTaskRepository();
  const now = Date.now();
  if (active.status === 'running' && active.chatId) {
    // The runner records the aborted turn as cancelled.
    abortChatRequest(active.chatId);
    return;
  }
  const run = await repository.mutateRun(task.id, active.id, stored => {
    if (isFinalRunStatus(stored.status)) return null;
    stored.status = 'cancelled';
    stored.finishedAt = new Date(now).toISOString();
    stored.reason = reasonOf(reasonCode, message, now);
    return stored;
  });
  // A queued or waiting run never reaches the runner again (it only executes
  // `queued` runs), so nothing else would release the task from it: left in
  // place, a task an admin re-activates refuses every Run now and skips every
  // slot as PREVIOUS_RUN_ACTIVE.
  await repository.mutateTask(task.id, stored => {
    if (stored.activeRun?.id !== active.id) return null;
    return applyRunOutcome(stored, run || { ...stored.activeRun, status: 'cancelled' }, {
      now,
      settings: currentPolicy().settings,
      notify: false
    });
  });
  if (active.status === 'awaiting_approval' && run?.approval?.interactionId) {
    try {
      await interactionService.cancel(run.approval.interactionId, 'cancelled');
    } catch (error) {
      logger.warn('Could not cancel a scheduled run approval', {
        component: COMPONENT,
        taskId: task.id,
        error: error.message
      });
    }
  }
}

/**
 * Delete a task and its run history; optionally its run chats too.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} [options]
 * @param {boolean} [options.deleteChats=false]
 * @returns {Promise<{deleted: boolean, chatsDeleted: number}>}
 */
export async function deleteTask(user, taskId, { deleteChats = false } = {}) {
  assertAvailable();
  const { task } = await loadOwnedTask(user, taskId);
  return removeTask(task, { deleteChats });
}

async function removeTask(task, { deleteChats }) {
  const repository = getScheduledTaskRepository();
  await stopActiveRun(task, 'TASK_DELETED', 'The task was deleted');
  await repository.deleteTask(task.id);
  // The notes go with the task even when the run history cannot be removed: once the task
  // record is gone nobody could reach them to clear them. A run that is still writing finds
  // the task gone and its write is refused.
  let runs;
  let runsError = null;
  try {
    runs = await repository.deleteRunsOfTask(task.id);
  } catch (error) {
    runsError = error;
  }
  await getTaskMemoryRepository().delete(task.id);
  if (runsError) throw runsError;
  let chatsDeleted = 0;
  if (deleteChats) {
    for (const run of runs) {
      if (!run.chatId || run.chatDeleted) continue;
      if (await deleteRunChat(run.chatId)) chatsDeleted += 1;
    }
  }
  announceTaskChanged(task.id);
  logger.info('Scheduled task deleted', {
    component: COMPONENT,
    taskId: task.id,
    runs: runs.length,
    chatsDeleted
  });
  return { deleted: true, chatsDeleted };
}

/**
 * Delete a run's chat with the same cascade the chat delete uses.
 *
 * @param {string} chatId
 * @returns {Promise<boolean>}
 */
export async function deleteRunChat(chatId) {
  const repository = getChatRepository();
  if (!repository.isAvailable()) return false;
  try {
    const chat = await repository.getChat(chatId);
    if (!chat) return false;
    await deleteChatWithCascade(repository, chatId, {
      deleteRun: runId => runLog.deleteRun(runId),
      removeWorkflowState: runId => getWorkflowStateRepository().remove(runId),
      component: COMPONENT
    });
    return true;
  } catch (error) {
    logger.warn('Could not delete a scheduled run chat', {
      component: COMPONENT,
      chatId,
      error: error.message
    });
    return false;
  }
}

/**
 * Ask for a run now.
 *
 * @param {Object} user
 * @param {string} taskId
 * @returns {Promise<Object>} The queued run.
 */
export async function requestRun(user, taskId) {
  assertAvailable();
  assertPrincipal(user);
  const { ownerId } = await loadOwnedTask(user, taskId);
  const repository = getScheduledTaskRepository();
  const now = Date.now();
  let queued = null;
  await repository.mutateTask(taskId, stored => {
    if (stored.ownerId !== ownerId) throw notFound();
    if (stored.status === 'disabled') {
      throw new ScheduledTaskError(
        409,
        'TASK_DISABLED',
        stored.statusReason?.message || 'This task is disabled and cannot run'
      );
    }
    if (stored.activeRun) {
      throw new ScheduledTaskError(409, 'RUN_IN_PROGRESS', 'The task is already running');
    }
    queued = newRunDocument(stored, { trigger: 'manual', status: 'queued', now });
    attachQueuedRun(stored, queued);
    return stored;
  });
  await repository.putRun(queued);
  announceTaskChanged(taskId);
  return queued;
}

/**
 * Cancel the run a task has in flight.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {string} runId
 * @returns {Promise<Object|null>} The run.
 */
export async function cancelRun(user, taskId, runId) {
  assertAvailable();
  const { task } = await loadOwnedTask(user, taskId);
  if (!isRunId(runId) || task.activeRun?.id !== runId) {
    throw new ScheduledTaskError(409, 'RUN_NOT_ACTIVE', 'This run is not in progress');
  }
  await stopActiveRun(task, 'CANCELLED_BY_OWNER', 'Cancelled by the owner');
  if (task.activeRun.status !== 'running') announceTaskChanged(taskId);
  return getScheduledTaskRepository().getRun(taskId, runId);
}

/**
 * A page of a task's runs, newest first.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} [options]
 * @returns {Promise<{items: Object[], nextCursor: string|null}>}
 */
export async function listRuns(user, taskId, { limit, cursor } = {}) {
  assertAvailable();
  await loadOwnedTask(user, taskId);
  return getScheduledTaskRepository().listRuns(taskId, { limit, cursor });
}

/**
 * One run of one of the caller's tasks.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {string} runId
 * @returns {Promise<Object>}
 */
export async function getRun(user, taskId, runId) {
  assertAvailable();
  await loadOwnedTask(user, taskId);
  const run = isRunId(runId) ? await getScheduledTaskRepository().getRun(taskId, runId) : null;
  if (!run) throw new ScheduledTaskError(404, 'RUN_NOT_FOUND', 'Run not found');
  return run;
}

/**
 * Remove a tool from the task's "always allow" list.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {string} toolId
 * @returns {Promise<Object>}
 */
export async function revokeAllowedTool(user, taskId, toolId) {
  assertAvailable();
  const { ownerId } = await loadOwnedTask(user, taskId);
  const { task } = await getScheduledTaskRepository().mutateTask(taskId, stored => {
    if (stored.ownerId !== ownerId) throw notFound();
    const before = Array.isArray(stored.allowedTools) ? stored.allowedTools : [];
    const after = before.filter(entry => entry.toolId !== toolId);
    if (after.length === before.length) return null;
    stored.allowedTools = after;
    return stored;
  });
  return task;
}

/**
 * Answer the approval a run is waiting for.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {string} runId
 * @param {Object} answer
 * @param {'approve'|'reject'} answer.decision
 * @param {boolean} [answer.alwaysAllow=false] - Keep approving this tool for this task.
 * @returns {Promise<Object>} The run.
 */
export async function answerApproval(user, taskId, runId, { decision, alwaysAllow = false }) {
  assertAvailable();
  await loadOwnedTask(user, taskId);
  const run = isRunId(runId) ? await getScheduledTaskRepository().getRun(taskId, runId) : null;
  if (!run || run.status !== 'awaiting_approval' || !run.approval?.interactionId) {
    throw new ScheduledTaskError(
      409,
      'NO_PENDING_APPROVAL',
      'This run is not waiting for approval'
    );
  }
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ScheduledTaskError(400, 'INVALID_DECISION', 'Decision must be approve or reject');
  }
  try {
    await interactionService.answer(
      run.approval.interactionId,
      {
        value: decision,
        decision,
        data: { alwaysAllow: decision === 'approve' && alwaysAllow === true },
        ...(decision === 'reject' ? { reason: 'Rejected by the task owner' } : {})
      },
      { user, channel: 'run_page' }
    );
  } catch (error) {
    if (error instanceof ScheduledTaskError) throw error;
    throw new ScheduledTaskError(
      Number.isInteger(error.status) ? error.status : 409,
      error.code || 'APPROVAL_FAILED',
      error.message
    );
  }
  return getScheduledTaskRepository().getRun(taskId, runId);
}

/**
 * Apply an answered scheduled-run approval to its task and run. Registered
 * as an `InteractionService.onAnswer` handler, so it runs on whichever worker
 * took the answer, before the answer is stored — throwing rejects the answer.
 *
 * @param {Object} interaction - Answered interaction.
 * @returns {Promise<void>}
 */
export async function applyApprovalAnswer(interaction) {
  const taskId = interaction?.source?.scheduledTaskId;
  const runId = interaction?.source?.scheduledRunId;
  if (!taskId || !runId || interaction.kind !== 'approval') return;
  const repository = getScheduledTaskRepository();
  const now = Date.now();
  const approved = interaction.answer?.decision === 'approve';
  const alwaysAllow = approved && interaction.answer?.data?.alwaysAllow === true;
  const toolId = interaction.source.toolId;
  const run = await repository.mutateRun(taskId, runId, stored => {
    if (
      stored.status !== 'awaiting_approval' ||
      stored.approval?.interactionId !== interaction.id
    ) {
      throw new ScheduledTaskError(
        409,
        'NO_PENDING_APPROVAL',
        'This run is not waiting for approval'
      );
    }
    stored.approval = {
      ...stored.approval,
      status: approved ? 'approved' : 'rejected',
      decidedAt: new Date(now).toISOString(),
      alwaysAllow
    };
    if (approved) {
      stored.status = 'queued';
      stored.continuation = { approvedToolId: toolId, interactionId: interaction.id };
    } else {
      stored.status = 'cancelled';
      stored.finishedAt = new Date(now).toISOString();
      stored.reason = reasonOf('APPROVAL_REJECTED', `The owner rejected running ${toolId}`, now);
    }
    return stored;
  });
  if (!run) {
    throw new ScheduledTaskError(404, 'RUN_NOT_FOUND', 'The run no longer exists');
  }
  await repository.mutateTask(taskId, stored => {
    if (alwaysAllow && toolId) {
      const list = Array.isArray(stored.allowedTools) ? stored.allowedTools : [];
      if (!list.some(entry => entry.toolId === toolId)) {
        stored.allowedTools = [...list, { toolId, allowedAt: new Date(now).toISOString() }];
      }
    }
    stored.unseenRuns = (stored.unseenRuns || []).filter(entry => entry.id !== runId);
    if (stored.activeRun?.id === runId) {
      if (approved) stored.activeRun = { ...stored.activeRun, status: 'queued' };
      else applyRunOutcome(stored, run, { now, settings: currentPolicy().settings, notify: false });
    }
    return stored;
  });
  announceTaskChanged(taskId);
}

/**
 * An expired scheduled-run approval fails its run.
 *
 * @param {Object} interaction
 * @returns {Promise<void>}
 */
export async function applyApprovalExpiry(interaction) {
  const taskId = interaction?.source?.scheduledTaskId;
  const runId = interaction?.source?.scheduledRunId;
  if (!taskId || !runId) return;
  await failAwaitingRun(
    taskId,
    runId,
    interaction.id,
    'APPROVAL_TIMED_OUT',
    'The approval timed out'
  );
}

/**
 * Fail a run that is waiting for an approval that will not come.
 *
 * @param {string} taskId
 * @param {string} runId
 * @param {string|null} interactionId - Only when it is still this approval.
 * @param {string} code
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function failAwaitingRun(taskId, runId, interactionId, code, message) {
  const repository = getScheduledTaskRepository();
  const now = Date.now();
  const run = await repository.mutateRun(taskId, runId, stored => {
    if (stored.status !== 'awaiting_approval') return null;
    if (interactionId && stored.approval?.interactionId !== interactionId) return null;
    stored.status = 'failed';
    stored.finishedAt = new Date(now).toISOString();
    stored.reason = reasonOf(code, message, now);
    stored.approval = { ...stored.approval, status: 'expired' };
    return stored;
  });
  if (!run || run.status !== 'failed') return;
  await repository.mutateTask(taskId, stored => {
    if (stored.activeRun?.id !== runId) return null;
    return applyRunOutcome(stored, run, { now, settings: currentPolicy().settings });
  });
  announceTaskChanged(taskId);
}

// ── notifications ──────────────────────────────────────────────────────────

/**
 * Runs the caller has not looked at yet, newest first.
 *
 * @param {Object} user
 * @returns {Promise<Array<Object>>}
 */
export async function listNotifications(user) {
  if (!currentPolicy().configured) return [];
  const { id: ownerId } = await ownerIdentity(user);
  const tasks = await getScheduledTaskRepository().listTasksByOwner(ownerId);
  const out = [];
  for (const task of tasks) {
    for (const entry of task.unseenRuns || []) {
      out.push({ ...entry, taskId: task.id, taskName: task.name, appId: task.appId });
    }
  }
  out.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  return out;
}

/**
 * Mark runs seen: the given ones, or every one.
 *
 * @param {Object} user
 * @param {Object} [options]
 * @param {string} [options.taskId]
 * @param {string[]} [options.runIds]
 * @returns {Promise<number>} How many were cleared.
 */
export async function markNotificationsSeen(user, { taskId, runIds } = {}) {
  if (!currentPolicy().configured) return 0;
  const { id: ownerId } = await ownerIdentity(user);
  const repository = getScheduledTaskRepository();
  const tasks = taskId
    ? [await repository.getTask(taskId)].filter(task => task?.ownerId === ownerId)
    : await repository.listTasksByOwner(ownerId);
  const ids = Array.isArray(runIds) ? new Set(runIds) : null;
  let cleared = 0;
  for (const task of tasks) {
    if (!task.unseenRuns?.length) continue;
    await repository.mutateTask(task.id, stored => {
      const before = stored.unseenRuns || [];
      const after = ids ? before.filter(entry => !ids.has(entry.id)) : [];
      if (after.length === before.length) return null;
      cleared += before.length - after.length;
      stored.unseenRuns = after;
      return stored;
    });
  }
  return cleared;
}

/**
 * The owner opened a run's chat: its notification is done. Never throws — a
 * failure here must not fail the chat read that triggered it.
 *
 * @param {Object} chat - Stored chat with `origin.createdVia === 'scheduled-task'`.
 * @returns {Promise<void>}
 */
export async function markRunChatSeen(chat) {
  const taskId = chat?.origin?.taskId;
  if (!isTaskId(taskId)) return;
  const repository = getScheduledTaskRepository();
  if (!repository.isAvailable()) return;
  try {
    await repository.mutateTask(taskId, stored => {
      if (stored.ownerId !== chat.ownerId) return null;
      const before = stored.unseenRuns || [];
      const after = before.filter(entry => entry.chatId !== chat.id);
      if (after.length === before.length) return null;
      stored.unseenRuns = after;
      return stored;
    });
  } catch (error) {
    logger.warn('Could not clear a run notification', {
      component: COMPONENT,
      taskId,
      chatId: chat.id,
      error: error.message
    });
  }
}

// ── previews ───────────────────────────────────────────────────────────────

/**
 * Validate a schedule and say what it means.
 *
 * @param {Object} input - `{ schedule, taskId? }`
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {string} [options.timezone]
 * @param {number} [options.count=5]
 * @returns {Object}
 */
export function previewTaskSchedule(input, { language = 'en', timezone, count = 5 } = {}) {
  const { settings } = currentPolicy();
  const preview = previewSchedule(input?.schedule || input, {
    language,
    timezone: isValidTimezone(timezone) ? timezone : 'UTC',
    minIntervalMinutes: settings.minIntervalMinutes,
    count,
    staggerMs: 0
  });
  return {
    ...preview,
    nextRunsLocal: preview.nextRuns.map(iso =>
      formatZonedIso(iso, preview.schedule.timezone || 'UTC')
    ),
    minIntervalMinutes: settings.minIntervalMinutes,
    staggerMinutes: settings.staggerMinutes
  };
}

// ── admin operations ───────────────────────────────────────────────────────

/**
 * Every task, for the admin overview.
 *
 * @param {Object} [options]
 * @param {string} [options.status]
 * @param {string} [options.language]
 * @returns {Promise<Object[]>}
 */
export async function adminListTasks({ status, language = 'en' } = {}) {
  const { settings } = currentPolicy();
  const repository = getScheduledTaskRepository();
  const out = [];
  for await (const task of repository.scanTasks()) {
    if (status && task.status !== status) continue;
    out.push(toPublicTask(task, { language, settings, admin: true }));
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

/**
 * One task, for an admin.
 *
 * @param {string} taskId
 * @returns {Promise<Object>}
 */
export async function adminGetTask(taskId, { language = 'en' } = {}) {
  const task = isTaskId(taskId) ? await getScheduledTaskRepository().getTask(taskId) : null;
  if (!task) throw notFound();
  return toPublicTask(task, { language, settings: currentPolicy().settings, admin: true });
}

/**
 * Pause, resume or disable any task.
 *
 * @param {Object} admin - Acting admin.
 * @param {string} taskId
 * @param {'paused'|'active'|'disabled'} status
 * @param {string} [message]
 * @returns {Promise<Object>}
 */
export async function adminSetTaskStatus(admin, taskId, status, message) {
  if (!['paused', 'active', 'disabled'].includes(status)) {
    throw new ScheduledTaskError(
      400,
      'INVALID_STATUS',
      'Status must be paused, active or disabled'
    );
  }
  if (!isTaskId(taskId)) throw notFound();
  const { settings } = currentPolicy();
  const now = Date.now();
  const by = admin?.username || admin?.id || 'admin';
  const { task } = await getScheduledTaskRepository().mutateTask(taskId, stored => {
    if (status === 'active') {
      if (stored.status === 'active') return null;
      return resumeTask(stored, { now, staggerMinutes: settings.staggerMinutes });
    }
    holdTask(
      stored,
      status,
      reasonOf(
        status === 'paused' ? 'PAUSED_BY_ADMIN' : 'DISABLED_BY_ADMIN',
        (typeof message === 'string' && message.trim().slice(0, 500)) ||
          (status === 'paused'
            ? `Paused by an administrator (${by})`
            : `Disabled by an administrator (${by})`),
        now
      )
    );
    return stored;
  });
  if (!task) throw notFound();
  if (status === 'disabled' && task.activeRun) {
    await stopActiveRun(task, 'DISABLED_BY_ADMIN', 'Disabled by an administrator');
    announceTaskChanged(taskId);
    return (await getScheduledTaskRepository().getTask(taskId)) || task;
  }
  announceTaskChanged(taskId);
  return task;
}

/**
 * A page of any task's runs, for an admin.
 *
 * @param {string} taskId
 * @param {Object} [options]
 * @returns {Promise<{items: Object[], nextCursor: string|null}>}
 */
export async function adminListRuns(taskId, { limit, cursor } = {}) {
  if (!isTaskId(taskId)) throw notFound();
  return getScheduledTaskRepository().listRuns(taskId, { limit, cursor });
}

/**
 * Delete any task, for an admin.
 *
 * @param {string} taskId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function adminDeleteTask(taskId, { deleteChats = false } = {}) {
  const task = isTaskId(taskId) ? await getScheduledTaskRepository().getTask(taskId) : null;
  if (!task) throw notFound();
  return removeTask(task, { deleteChats });
}

/**
 * Delete every task a user owns, with its run history, notes and run chats: what
 * deleting the user needs. A task is a standing instruction to act as its owner,
 * so it cannot outlive them.
 *
 * A task's owner id is the run principal, which differs by identity mode, so the
 * caller names each id the user may have been filed under.
 *
 * @param {string[]} ownerIds - Every principal id the user may own tasks as
 * @returns {Promise<{tasks: number, chatsDeleted: number}>}
 */
export async function deleteTasksOfOwner(ownerIds) {
  const repository = getScheduledTaskRepository();
  let tasks = 0;
  let chatsDeleted = 0;
  for (const ownerId of new Set(ownerIds)) {
    for (const task of await repository.listTasksByOwner(ownerId)) {
      const result = await removeTask(task, { deleteChats: true });
      tasks += 1;
      chatsDeleted += result.chatsDeleted;
    }
  }
  return { tasks, chatsDeleted };
}

// ── memory ─────────────────────────────────────────────────────────────────

/** A memory store error as the error the routes and tools already know. */
function memoryFailure(error) {
  if (!(error instanceof TaskMemoryError)) return error;
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return new ScheduledTaskError(409, 'VERSION_CONFLICT', error.message, {
        currentVersion: error.currentVersion
      });
    case 'MEMORY_TOO_LONG':
      return new ScheduledTaskError(400, 'MEMORY_TOO_LONG', error.message, {
        chars: error.chars,
        maxChars: error.maxChars
      });
    case 'TASK_NOT_FOUND':
      return notFound();
    default:
      return new ScheduledTaskError(503, error.code || 'MEMORY_UNAVAILABLE', error.message);
  }
}

/**
 * The notes a task keeps between runs, for their owner. Readable while memory
 * is switched off (the notes are kept), so the owner can still see and clear
 * them.
 *
 * @param {Object} user
 * @param {string} taskId
 * @returns {Promise<{enabled: boolean, platformEnabled: boolean, body: string, version: number,
 *   chars: number, maxChars: number, updatedAt: string|null, updatedBy: string|null}>}
 */
export async function getTaskMemory(user, taskId) {
  const { settings } = assertAvailable();
  const { task } = await loadOwnedTask(user, taskId);
  const doc = await readTaskMemory(task);
  return {
    enabled: task.memory?.enabled === true,
    platformEnabled: settings.memoryEnabled,
    body: doc.body,
    version: doc.version,
    chars: doc.chars,
    maxChars: settings.memoryMaxChars,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy
  };
}

/**
 * Replace the notes of a task. Editing them changes what the task does, so it
 * needs the same permission editing the task does.
 *
 * @param {Object} user
 * @param {string} taskId
 * @param {Object} input
 * @param {string} input.content
 * @param {number} [input.expectedVersion] - Without it the write wins over any version.
 * @returns {Promise<{version: number, chars: number, updatedAt: string}>}
 */
export async function setTaskMemory(user, taskId, { content, expectedVersion } = {}) {
  const { settings } = assertAvailable();
  assertPrincipal(user);
  const { task } = await loadOwnedTask(user, taskId);
  if (typeof content !== 'string') {
    throw new ScheduledTaskError(400, 'INVALID_BODY', 'content must be a string');
  }
  const versioned = expectedVersion != null;
  if (versioned && !(Number.isInteger(expectedVersion) && expectedVersion >= 0)) {
    throw new ScheduledTaskError(
      400,
      'INVALID_BODY',
      'expectedVersion must be a non-negative integer'
    );
  }
  try {
    const result = await writeTaskMemory(task, {
      mode: 'replace',
      content,
      ...(versioned ? { expectedVersion } : {}),
      updatedBy: 'owner',
      maxChars: settings.memoryMaxChars
    });
    announceTaskChanged(task.id);
    return { version: result.version, chars: result.chars, updatedAt: result.updatedAt };
  } catch (error) {
    throw memoryFailure(error);
  }
}

/**
 * Clear the notes of a task. Like deleting what one owns, it needs no
 * permission: a user whose permission was withdrawn can still clean up.
 *
 * @param {Object} user
 * @param {string} taskId
 * @returns {Promise<{version: number}>}
 */
export async function deleteTaskMemory(user, taskId) {
  assertAvailable();
  const { task } = await loadOwnedTask(user, taskId);
  try {
    const result = await clearTaskMemory(task, { updatedBy: 'owner' });
    announceTaskChanged(task.id);
    return result;
  } catch (error) {
    throw memoryFailure(error);
  }
}

/**
 * What an admin sees of a task's notes: metadata only, never the content.
 *
 * @param {string} taskId
 * @returns {Promise<Object>}
 */
export async function adminGetTaskMemory(taskId) {
  const task = isTaskId(taskId) ? await getScheduledTaskRepository().getTask(taskId) : null;
  if (!task) throw notFound();
  return taskMemoryMetadata(task);
}

/**
 * Clear a task's notes as an admin.
 *
 * @param {string} taskId
 * @returns {Promise<{version: number}>}
 */
export async function adminClearTaskMemory(taskId) {
  const task = isTaskId(taskId) ? await getScheduledTaskRepository().getTask(taskId) : null;
  if (!task) throw notFound();
  try {
    const result = await clearTaskMemory(task, { updatedBy: 'admin' });
    announceTaskChanged(task.id);
    return result;
  } catch (error) {
    throw memoryFailure(error);
  }
}

// Re-exported for the runner, which records outcomes the same way.

export { activeRunOf, lastRunOf, applyRunOutcome } from './taskModel.js';
