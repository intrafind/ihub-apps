// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage limits: who a caller is for quota purposes, whether a model call is
 * still within their budget, counting what it used, and the buckets the
 * user and admin views show.
 *
 * Enforced in one place, `LLMClient.execute` — every model call of a chat,
 * an agent loop step, a workflow node, a scheduled task or the Inference API
 * passes through it. The check runs before a call; what the call used is
 * counted when it ends, so the call that crosses a limit still finishes and
 * the next one is refused.
 *
 * @module services/quota/quotaService
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { loadUsers } from '../../utils/userManager.js';
import { localUsersFile } from '../../utils/contentsPath.js';
import { LLMError, LLM_ERROR_CODES } from '../loop/contracts/errors.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { guestIdOf, guestOwnerId } from '../chat/chatOwner.js';
import { chatFilePolicy } from '../chatFiles/chatFilePolicy.js';
import { currentWindows, normalizeResets, WINDOWS } from './resetSchedule.js';
import { resolveLimits, isLimited } from './limitResolver.js';
import { getQuotaLedger } from './QuotaLedger.js';

const COMPONENT = 'QuotaService';

/** Share of a limit from which the UI warns. */
export const WARNING_THRESHOLD = 0.8;

/**
 * The key a caller's usage is counted under: the user id, a guest's hashed
 * cookie id, or null for a call without a principal (system work).
 *
 * @param {Object|null} user
 * @returns {string|null}
 */
export function quotaUserKey(user) {
  if (!user || typeof user !== 'object') return null;
  if (isAnonymousUser(user)) {
    const guestId = guestIdOf(user);
    return guestId ? guestOwnerId(guestId) : 'anonymous';
  }
  return String(user.id);
}

function platformConfig() {
  return configCache.getPlatform?.() || {};
}

/** The reset schedule in force. */
export function getResetSchedule() {
  return normalizeResets(platformConfig().usageLimits?.resets);
}

/** `currentWindows()` of the configured schedule. */
export function getCurrentWindows(now = Date.now()) {
  return currentWindows(platformConfig().usageLimits?.resets, now);
}

function groupsMap() {
  return configCache.getGroups?.()?.data?.groups || {};
}

function allModels() {
  return configCache.getModels?.(true)?.data || [];
}

/** users.json → users map (empty on any failure). */
export function usersMap() {
  try {
    const config = loadUsers(localUsersFile(platformConfig().localAuth));
    return config?.users || {};
  } catch {
    return {};
  }
}

function userRecordOf(user, users = null) {
  if (!user?.id || isAnonymousUser(user)) return null;
  const map = users || usersMap();
  return Object.hasOwn(map, user.id) ? map[user.id] : null;
}

/** Platform config with the effective per-user file storage default. */
function platformForLimits() {
  const platform = platformConfig();
  let maxUserBytes;
  try {
    maxUserBytes = chatFilePolicy().quotas.maxUserBytes;
  } catch {
    maxUserBytes = platform?.uploads?.quotas?.maxUserBytes;
  }
  return {
    ...platform,
    uploads: {
      ...(platform.uploads || {}),
      quotas: { ...(platform.uploads?.quotas || {}), maxUserBytes }
    }
  };
}

/**
 * The resolved limits of a user.
 *
 * @param {Object} user
 * @param {Object} [options]
 * @param {Array<Object>} [options.models] - Restrict to these models
 * @param {Object} [options.users] - users.json map (looked up when omitted)
 */
export function getUserLimits(user, { models, users } = {}) {
  return resolveLimits({
    user,
    userRecord: userRecordOf(user, users),
    models: models || allModels(),
    groups: groupsMap(),
    platform: platformForLimits()
  });
}

/**
 * The user's file storage limit in bytes: `null` when unlimited, `0` when an
 * admin blocked uploads for them (a group or user `fileStorageBytes: 0`).
 *
 * @param {Object} user
 * @returns {number|null}
 */
export function getUserFileStorageLimit(user) {
  try {
    const { limit } = getUserLimits(user, { models: [] }).fileStorageBytes;
    return Number.isFinite(limit) ? limit : null;
  } catch (error) {
    logger.warn('Could not resolve file storage limit', {
      component: COMPONENT,
      error: error.message
    });
    const fallback = chatFilePolicy().quotas.maxUserBytes;
    return fallback > 0 ? fallback : null;
  }
}

/**
 * A chat-file policy with the user's own storage limit in place of the
 * platform default.
 *
 * `uploads.quotas.maxUserBytes` reads 0 as "no limit", so a limit of 0 —
 * uploads blocked for this user — cannot be passed on as a byte count (a cap
 * of a byte or so would make the quota check evict the user's stored
 * originals to make room). It turns uploads off instead, which every upload
 * route already answers with "uploads disabled".
 *
 * @param {Object} policy - `chatFilePolicy()`
 * @param {Object} user
 */
export function withUserFileLimit(policy, user) {
  if (!policy || !user) return policy;
  const limit = getUserFileStorageLimit(user);
  if (limit === 0) return { ...policy, enabled: false, uploadsBlockedForUser: true };
  const maxUserBytes = limit ?? 0;
  return {
    ...policy,
    maxUserBytes,
    quotas: { ...(policy.quotas || {}), maxUserBytes }
  };
}

function bucket({ scope, modelId, modelName, window, entry, used, windows }) {
  const limit = entry.limit;
  const remaining = Math.max(0, limit - used);
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 100;
  return {
    id: scope === 'model' ? `model:${modelId}:${window}` : `allModels:${window}`,
    scope,
    modelId: modelId ?? null,
    modelName: modelName ?? null,
    window,
    used,
    limit,
    remaining,
    percent,
    exceeded: used >= limit,
    warning: used < limit && limit > 0 && used / limit >= WARNING_THRESHOLD,
    resetAt: windows[window].resetAt,
    source: entry.source
  };
}

function modelName(model, language = 'en') {
  const name = model?.name;
  if (!name) return model?.id || null;
  if (typeof name === 'string') return name;
  return name[language] || name.en || Object.values(name)[0] || model.id;
}

/**
 * Every limited bucket of a user, with what has been used.
 *
 * @param {Object} params
 * @param {Object} params.limits - `getUserLimits()`
 * @param {Object} params.counts - `ledger.getUser()`
 * @param {Object} params.windows - `getCurrentWindows()`
 * @param {Array<Object>} [params.models]
 * @param {string} [params.language]
 */
export function buildBuckets({ limits, counts, windows, models = allModels(), language }) {
  const byId = new Map(models.map(m => [m.id, m]));
  const buckets = [];
  for (const window of WINDOWS) {
    const entry = limits.allModels[window];
    if (isLimited(entry)) {
      buckets.push(
        bucket({ scope: 'allModels', window, entry, used: counts.allModels[window] || 0, windows })
      );
    }
  }
  for (const [modelId, perWindow] of Object.entries(limits.models)) {
    for (const window of WINDOWS) {
      const entry = perWindow[window];
      if (!isLimited(entry)) continue;
      buckets.push(
        bucket({
          scope: 'model',
          modelId,
          modelName: modelName(byId.get(modelId), language),
          window,
          entry,
          used: counts.models[modelId]?.[window] || 0,
          windows
        })
      );
    }
  }
  return buckets;
}

/**
 * The error a refused call ends with. An `LLMError`, so chat, workflows and
 * the Inference API report it like any other failed model call.
 */
export function quotaExceededError(exceeded) {
  const scopeText =
    exceeded.scope === 'model'
      ? `${exceeded.window === 'day' ? 'daily' : exceeded.window === 'week' ? 'weekly' : 'monthly'} token limit for ${exceeded.modelName || exceeded.modelId}`
      : `${exceeded.window === 'day' ? 'daily' : exceeded.window === 'week' ? 'weekly' : 'monthly'} token limit across all models`;
  const error = new LLMError(
    `You have reached your ${scopeText} (${exceeded.limit.toLocaleString('en-US')} tokens). It resets at ${exceeded.resetAt}.`,
    {
      code: LLM_ERROR_CODES.QUOTA_EXCEEDED,
      providerCode: 'USAGE_LIMIT',
      modelId: exceeded.modelId,
      details: {
        scope: exceeded.scope,
        modelId: exceeded.modelId,
        modelName: exceeded.modelName,
        window: exceeded.window,
        limit: exceeded.limit,
        used: exceeded.used,
        resetAt: exceeded.resetAt,
        source: exceeded.source,
        timezone: getResetSchedule().timezone
      }
    }
  );
  return error;
}

/**
 * The first exhausted bucket for a call of `model` by `user`, or null.
 *
 * @param {Object} user
 * @param {Object} model
 * @returns {Promise<Object|null>}
 */
export async function findExceededBucket(user, model) {
  const userKey = quotaUserKey(user);
  if (!userKey || !model?.id) return null;
  const limits = getUserLimits(user, { models: [model] });
  const modelLimits = limits.models[model.id] || {};
  const relevant = WINDOWS.some(w => isLimited(modelLimits[w]) || isLimited(limits.allModels[w]));
  if (!relevant) return null;
  const windows = getCurrentWindows();
  const counts = await getQuotaLedger().getUser(userKey, windows);
  const buckets = buildBuckets({ limits, counts, windows, models: [model] });
  // A blocked model (limit 0) or a used-up budget; the shortest window first.
  return buckets.find(b => b.exceeded) || null;
}

/**
 * Refuse a model call that would run over the caller's budget.
 *
 * @param {Object|null} user
 * @param {Object} model
 * @throws {LLMError} code `QUOTA_EXCEEDED`
 */
export async function assertWithinQuota(user, model) {
  let exceeded = null;
  try {
    exceeded = await findExceededBucket(user, model);
  } catch (error) {
    // Fails closed, like every permission lookup: a limit that cannot be
    // checked is not waived. (An unreadable ledger file is not an error here
    // — it reads as no usage — so this is a config or code fault.)
    logger.error('Usage limit check failed; refusing the call', {
      component: COMPONENT,
      modelId: model?.id,
      error
    });
    throw new LLMError(
      'Usage limits could not be checked. Please try again or contact your administrator.',
      {
        code: LLM_ERROR_CODES.QUOTA_EXCEEDED,
        providerCode: 'USAGE_LIMIT_CHECK_FAILED',
        modelId: model?.id ?? null,
        details: { scope: 'check', modelId: model?.id ?? null }
      }
    );
  }
  if (exceeded) throw quotaExceededError(exceeded);
}

function displayName(user) {
  if (!user || isAnonymousUser(user)) return null;
  return user.name || user.fullName || user.username || user.email || null;
}

/**
 * Count what a model call used.
 *
 * @param {Object|null} user
 * @param {Object} params
 * @param {Object} params.model
 * @param {Object|null} params.usage - Normalized usage (`promptTokens`, `completionTokens`)
 * @param {string} [params.appId]
 */
export function recordModelUsage(user, { model, usage, appId }) {
  try {
    const userKey = quotaUserKey(user);
    if (!userKey || !model?.id || !usage) return;
    const tokens = (Number(usage.promptTokens) || 0) + (Number(usage.completionTokens) || 0);
    if (tokens <= 0) return;
    getQuotaLedger().record(userKey, {
      modelId: model.id,
      appId,
      tokens,
      windows: getCurrentWindows(),
      name: displayName(user),
      groups: Array.isArray(user?.groups) ? user.groups : undefined
    });
  } catch (error) {
    logger.warn('Could not record usage for limits', {
      component: COMPONENT,
      error: error.message
    });
  }
}

/**
 * Everything the "Usage" page of a user shows.
 *
 * @param {Object} user
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {string} [options.userKey] - Count under this key (admin view of a user)
 */
export async function getQuotaStatus(user, { language, userKey } = {}) {
  const models = allModels();
  const limits = getUserLimits(user, { models });
  const windows = getCurrentWindows();
  const key = userKey || quotaUserKey(user);
  const counts = key
    ? await getQuotaLedger().getUser(key, windows)
    : { models: {}, allModels: { day: 0, week: 0, month: 0 }, apps: {} };
  const buckets = buildBuckets({ limits, counts, windows, models, language });
  const byId = new Map(models.map(m => [m.id, m]));
  const modelRows = Object.keys(limits.models).map(modelId => {
    const perWindow = limits.models[modelId];
    const modelBuckets = buckets.filter(b => b.modelId === modelId);
    return {
      modelId,
      name: modelName(byId.get(modelId), language),
      usage: counts.models[modelId] || { day: 0, week: 0, month: 0 },
      limited: WINDOWS.some(w => isLimited(perWindow[w])),
      exceeded: modelBuckets.some(b => b.exceeded),
      warning: modelBuckets.some(b => b.warning)
    };
  });
  // Models the user used but may no longer use still show what they used.
  for (const [modelId, usage] of Object.entries(counts.models)) {
    if (limits.models[modelId]) continue;
    if (!usage.month) continue;
    modelRows.push({
      modelId,
      name: modelName(byId.get(modelId), language),
      usage,
      limited: false,
      exceeded: false,
      warning: false,
      unavailable: true
    });
  }
  const fileLimit = limits.fileStorageBytes;
  return {
    buckets,
    models: modelRows,
    totals: counts.allModels,
    apps: Object.entries(counts.apps)
      .map(([appId, tokens]) => ({ appId, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    files: {
      limit: Number.isFinite(fileLimit.limit) ? fileLimit.limit : null,
      source: fileLimit.source
    },
    resets: {
      schedule: getResetSchedule(),
      day: windows.day.resetAt,
      week: windows.week.resetAt,
      month: windows.month.resetAt
    }
  };
}
