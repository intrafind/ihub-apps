/**
 * Scheduled task policy — whether the feature is on, who may use it, and the
 * platform limits it runs under.
 *
 * Kept free of routes and storage so the request path, the scheduler (which
 * runs with no request in scope) and the tools all ask the same questions the
 * same way.
 *
 * @module services/scheduler/tasks/taskPolicy
 */
import { featureRegistry, isFeatureEnabled } from '../../../featureRegistry.js';
import { isChatPersistenceConfigured } from '../../chat/chatPersistence.js';
import { isAnonymousUser } from '../../loop/runIdentity.js';

/** Feature flag that gates scheduled tasks. */
export const SCHEDULED_TASKS_FEATURE = 'scheduledTasks';

/** Group permission that lets a user create and run scheduled tasks. */
export const SCHEDULED_TASKS_PERMISSION = 'scheduledTasks';

/** `origin.createdVia` of a chat a scheduled run created. */
export const SCHEDULED_TASK_ORIGIN = 'scheduled-task';

/** Usage / ledger source of scheduled work. */
export const SCHEDULED_TASK_SOURCE = 'scheduled-task';

/**
 * Auth modes whose token acts on a user's behalf rather than being the user's
 * own session. A leaked API key must not be able to plant a recurring task.
 */
const DELEGATED_AUTH_MODES = Object.freeze(['oauth_authorization_code', 'oauth_personal_key']);

/** Defaults of `platform.scheduledTasks`. */
export const DEFAULT_SCHEDULED_TASK_SETTINGS = Object.freeze({
  enabled: true,
  maxTasksPerUser: 10,
  minIntervalMinutes: 15,
  maxConcurrentRuns: 4,
  maxConcurrentRunsPerUser: 1,
  staggerMinutes: 5,
  catchUpWindowHours: 24,
  maxConsecutiveFailures: 3,
  approvalTimeoutHours: 24,
  runRetentionDays: 90,
  maxRunChatsPerTask: 20,
  maxInstructionLength: 8000,
  maxRunMinutes: 30,
  memoryEnabled: true,
  memoryMaxChars: 8000,
  maxHistoryReadChars: 8000
});

/** Bounds each numeric setting is clamped into. */
const SETTING_BOUNDS = Object.freeze({
  maxTasksPerUser: [0, 10_000],
  minIntervalMinutes: [1, 60 * 24 * 31],
  maxConcurrentRuns: [1, 100],
  maxConcurrentRunsPerUser: [1, 100],
  staggerMinutes: [0, 60],
  catchUpWindowHours: [0, 24 * 31],
  maxConsecutiveFailures: [0, 1000],
  approvalTimeoutHours: [1, 24 * 31],
  runRetentionDays: [0, 3650],
  maxRunChatsPerTask: [0, 10_000],
  maxInstructionLength: [100, 100_000],
  maxRunMinutes: [1, 30],
  memoryMaxChars: [1000, 64_000],
  maxHistoryReadChars: [1000, 50_000]
});

function clampNumber(value, [min, max], fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * `platform.scheduledTasks` with defaults filled and every number clamped.
 *
 * `maxTasksPerUser`, `maxConsecutiveFailures`, `runRetentionDays` and
 * `maxRunChatsPerTask` accept 0 as "no limit" / "never".
 *
 * The memory settings are flat keys like the rest: `memoryEnabled` switches
 * memory between runs off for the whole installation (notes are kept, runs do
 * not use them), `memoryMaxChars` caps one task's notes and
 * `maxHistoryReadChars` caps what one `get_task_run` call returns.
 *
 * @param {Object} [platformConfig]
 * @returns {typeof DEFAULT_SCHEDULED_TASK_SETTINGS}
 */
export function scheduledTaskSettings(platformConfig) {
  const raw = platformConfig?.scheduledTasks || {};
  const out = { enabled: raw.enabled !== false, memoryEnabled: raw.memoryEnabled !== false };
  for (const [key, bounds] of Object.entries(SETTING_BOUNDS)) {
    out[key] = clampNumber(raw[key], bounds, DEFAULT_SCHEDULED_TASK_SETTINGS[key]);
  }
  return out;
}

/** Whether the flag exists in the registry (unknown flags read as on). */
function isFeatureRegistered(featureId) {
  return featureRegistry.some(entry => entry.id === featureId);
}

/**
 * Whether the installation runs scheduled tasks: the flag is on, durable
 * chats are available (every run is a chat), and `platform.scheduledTasks`
 * is not switched off.
 *
 * @param {Object} [features]
 * @param {Object} [platformConfig]
 * @param {() => boolean} [storageReady] - Injectable for tests.
 * @returns {boolean}
 */
export function isScheduledTasksConfigured(features, platformConfig, storageReady) {
  if (!isFeatureRegistered(SCHEDULED_TASKS_FEATURE)) return false;
  if (!isFeatureEnabled(SCHEDULED_TASKS_FEATURE, features || {})) return false;
  if (!isChatPersistenceConfigured(features, platformConfig, storageReady)) return false;
  return scheduledTaskSettings(platformConfig).enabled;
}

/**
 * Whether a principal may own scheduled tasks: a real, interactive user whose
 * groups grant the permission. Anonymous users, OAuth clients, agents and
 * delegated tokens never may.
 *
 * `user.permissions` must already be expanded (`enhanceUserWithPermissions`).
 *
 * @param {Object|null} user
 * @returns {{ok: boolean, code?: string}}
 */
export function checkTaskPrincipal(user) {
  if (isAnonymousUser(user)) return { ok: false, code: 'AUTHENTICATION_REQUIRED' };
  if (user.isOAuthClient || user.isAgent === true) {
    return { ok: false, code: 'INTERACTIVE_USER_REQUIRED' };
  }
  if (DELEGATED_AUTH_MODES.includes(user.authMode)) {
    return { ok: false, code: 'INTERACTIVE_USER_REQUIRED' };
  }
  if (user.permissions?.[SCHEDULED_TASKS_PERMISSION] !== true) {
    return { ok: false, code: 'PERMISSION_DENIED' };
  }
  return { ok: true };
}

/**
 * {@link checkTaskPrincipal} as a boolean.
 *
 * @param {Object|null} user
 * @returns {boolean}
 */
export function canUseScheduledTasks(user) {
  return checkTaskPrincipal(user).ok;
}

/**
 * What the client needs to know: whether scheduled tasks are on, and the
 * limits the task form has to respect.
 *
 * @param {Object} [features]
 * @param {Object} [platformConfig]
 * @returns {{enabled: boolean, minIntervalMinutes?: number, staggerMinutes?: number,
 *   maxTasksPerUser?: number, maxInstructionLength?: number, memoryEnabled?: boolean,
 *   memoryMaxChars?: number}}
 */
export function scheduledTasksClientConfig(features, platformConfig) {
  if (!isScheduledTasksConfigured(features, platformConfig)) return { enabled: false };
  const settings = scheduledTaskSettings(platformConfig);
  return {
    enabled: true,
    minIntervalMinutes: settings.minIntervalMinutes,
    staggerMinutes: settings.staggerMinutes,
    maxTasksPerUser: settings.maxTasksPerUser,
    maxInstructionLength: settings.maxInstructionLength,
    memoryEnabled: settings.memoryEnabled,
    memoryMaxChars: settings.memoryMaxChars
  };
}
