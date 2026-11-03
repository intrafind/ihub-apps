// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Effective usage limits of a user.
 *
 * Limits come from four levels; each can only lower what the one above
 * allows:
 *
 *   1. the **model** (`usageLimits: { day, week, month }` on the model) — the
 *      global per-user ceiling of that model; the **platform**
 *      (`usageLimits.allModels`) is the same for the budget across all models,
 *      and `uploads.quotas.maxUserBytes` for file storage;
 *   2. the user's **groups** (`usageLimits` on a group);
 *   3. the **user** (`usageLimits` on the user's record in users.json).
 *
 * A group without an entry is neutral. Across the groups that have one, the
 * most generous wins (a user in "Interns" and "Power users" gets the power
 * user's budget). A group without its own entry inherits the entry of its
 * parents (`inherits`). A model id entry beats the `*` entry of the same group.
 *
 * Values: a number ≥ 0 is a limit (0 blocks), `-1` (or missing) is unlimited.
 *
 * @module services/quota/limitResolver
 */
import { WINDOWS } from './resetSchedule.js';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A configured value as a limit: a number ≥ 0, Infinity for -1, undefined when unset. */
export function limitValue(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return Infinity;
  return Math.floor(n);
}

function own(obj, key) {
  return obj && typeof obj === 'object' && !UNSAFE_KEYS.has(key) && Object.hasOwn(obj, key)
    ? obj[key]
    : undefined;
}

/** The entry a `usageLimits` object holds for `path` (`['models', id, window]` …). */
function entryOf(usageLimits, kind, modelId, window) {
  if (!usageLimits || typeof usageLimits !== 'object') return undefined;
  if (kind === 'model') {
    const models = own(usageLimits, 'models');
    const specific = limitValue(own(own(models, modelId), window));
    if (specific !== undefined) return specific;
    return limitValue(own(own(models, '*'), window));
  }
  if (kind === 'allModels') return limitValue(own(own(usageLimits, 'allModels'), window));
  if (kind === 'files') return limitValue(own(usageLimits, 'fileStorageBytes'));
  return undefined;
}

/**
 * The entry a group gives for a limit — its own, else the most generous of
 * its parents' — with the group it was set on; undefined when none (neutral).
 *
 * @returns {{value: number, groupId: string}|undefined}
 */
function groupEntry(groups, groupId, kind, modelId, window, seen = new Set()) {
  if (seen.has(groupId)) return undefined;
  seen.add(groupId);
  const group = own(groups, groupId);
  if (!group || group.enabled === false) return undefined;
  const value = entryOf(group.usageLimits, kind, modelId, window);
  if (value !== undefined) return { value, groupId };
  let best;
  for (const parent of Array.isArray(group.inherits) ? group.inherits : []) {
    const inherited = groupEntry(groups, parent, kind, modelId, window, new Set(seen));
    if (inherited && (!best || inherited.value > best.value)) best = inherited;
  }
  return best;
}

/** Most generous entry across the user's groups, with the group it came from. */
function groupsEntry(groups, userGroups, kind, modelId, window) {
  let best;
  for (const groupId of userGroups) {
    const entry = groupEntry(groups, groupId, kind, modelId, window);
    if (entry && (!best || entry.value > best.value)) best = entry;
  }
  return best
    ? { value: best.value, source: `group:${best.groupId}` }
    : { value: undefined, source: null };
}

/** The lowest of the candidates, with its source; unlimited when none limits. */
function lowest(candidates) {
  let limit = Infinity;
  let source = null;
  for (const { value, source: from } of candidates) {
    if (value !== undefined && value < limit) {
      limit = value;
      source = from;
    }
  }
  return { limit, source };
}

/** Whether the user's permissions allow model `modelId`. */
export function modelPermitted(user, modelId) {
  const allowed = user?.permissions?.models;
  if (!allowed) return true;
  if (allowed instanceof Set) return allowed.has('*') || allowed.has(modelId);
  if (Array.isArray(allowed)) return allowed.includes('*') || allowed.includes(modelId);
  return true;
}

/**
 * Resolve every limit of a user.
 *
 * @param {Object} params
 * @param {Object} params.user - Principal (`groups`, `permissions`)
 * @param {Object|null} [params.userRecord] - The user's users.json record
 * @param {Array<Object>} [params.models] - Model configs
 * @param {Object} [params.groups] - Groups map (`groups.json` → `groups`)
 * @param {Object} [params.platform] - Platform config
 * @returns {{
 *   models: Object<string, Object<string, {limit: number, source: string|null}>>,
 *   allModels: Object<string, {limit: number, source: string|null}>,
 *   fileStorageBytes: {limit: number, source: string|null}
 * }} `limit` is Infinity when unlimited; `models` holds every model the user may use.
 */
export function resolveLimits({
  user,
  userRecord = null,
  models = [],
  groups = {},
  platform = {}
}) {
  const userGroups = Array.isArray(user?.groups) ? user.groups : [];
  const userLimits = userRecord?.usageLimits || user?.usageLimits || null;

  const resolve = (kind, ceiling, modelId, window) => {
    const group = groupsEntry(groups, userGroups, kind, modelId, window);
    return lowest([
      ceiling,
      group,
      { value: entryOf(userLimits, kind, modelId, window), source: 'user' }
    ]);
  };

  const result = { models: {}, allModels: {}, fileStorageBytes: null };

  for (const model of models) {
    if (!model?.id || model.enabled === false || !modelPermitted(user, model.id)) continue;
    const perWindow = {};
    for (const window of WINDOWS) {
      perWindow[window] = resolve(
        'model',
        { value: limitValue(own(model.usageLimits, window)), source: 'model' },
        model.id,
        window
      );
    }
    result.models[model.id] = perWindow;
  }

  const platformLimits = platform?.usageLimits || {};
  for (const window of WINDOWS) {
    result.allModels[window] = resolve(
      'allModels',
      { value: limitValue(own(own(platformLimits, 'allModels'), window)), source: 'platform' },
      null,
      window
    );
  }

  const quotas = platform?.uploads?.quotas || {};
  const rawUserBytes = quotas.maxUserBytes ?? platform?.uploads?.maxUserBytes;
  const platformBytes =
    rawUserBytes === undefined || rawUserBytes === null
      ? undefined
      : Number(rawUserBytes) > 0
        ? Math.floor(Number(rawUserBytes))
        : Infinity;
  result.fileStorageBytes = resolve(
    'files',
    { value: platformBytes, source: 'platform' },
    null,
    null
  );

  return result;
}

/** Whether a resolved window limit restricts anything. */
export function isLimited(entry) {
  return Boolean(entry) && Number.isFinite(entry.limit);
}
