// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Live token counters for usage limits: per user × model × window.
 *
 * Kept apart from the analytics in usageTracker.js on purpose: limits need
 * the real user (analytics may pseudonymize it) and the current numbers
 * (analytics rollups lag up to an hour). Only counts are stored, no content.
 *
 * File: `contents/data/quota-usage.json`
 * ```
 * { users: { <userKey>: {
 *     name, groups, lastSeen,
 *     models: { <modelId>: { day: {key, tokens}, week: {key, tokens}, month: {key, tokens} } },
 *     apps:   { <appId>:   { key, tokens } }          // month window
 * } } }
 * ```
 * `key` is the start of the window the count belongs to (see
 * resetSchedule.js); a count whose key is not the current window's counts as
 * zero, so nothing has to run at a reset.
 *
 * Every cluster worker counts into `pending` and adds it to the file under a
 * lock (utils/sharedJsonFile.js), like usageTracker.js.
 *
 * @module services/quota/QuotaLedger
 */
import { createSharedJsonFile } from '../../utils/sharedJsonFile.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import logger from '../../utils/logger.js';
import { WINDOWS } from './resetSchedule.js';

const COMPONENT = 'QuotaLedger';
const FLUSH_INTERVAL_MS = 3000;
/** Users not seen for this long are dropped from the file. */
const PRUNE_AFTER_MS = 400 * 24 * 60 * 60 * 1000;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeKey(key) {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key);
}

function createDefault() {
  return { version: 1, users: {} };
}

/** Add counter `delta` (`{key, tokens}`) to `target[name]`; the later window wins. */
function addWindow(target, name, delta) {
  const current = target[name];
  if (!current || typeof current !== 'object' || !current.key || delta.key > current.key) {
    target[name] = { key: delta.key, tokens: delta.tokens };
  } else if (current.key === delta.key) {
    current.tokens = (Number(current.tokens) || 0) + delta.tokens;
  }
  // A delta for an older window than the stored one is dropped.
}

function ensureUser(users, userKey) {
  if (!users[userKey] || typeof users[userKey] !== 'object') {
    users[userKey] = { models: {}, apps: {} };
  }
  const entry = users[userKey];
  if (!entry.models || typeof entry.models !== 'object') entry.models = {};
  if (!entry.apps || typeof entry.apps !== 'object') entry.apps = {};
  return entry;
}

/** Merge a pending delta (same shape as the file) into `data`. */
function mergeInto(data, delta) {
  if (!data.users || typeof data.users !== 'object') data.users = {};
  for (const [userKey, user] of Object.entries(delta.users)) {
    if (!safeKey(userKey)) continue;
    const target = ensureUser(data.users, userKey);
    if (user.name) target.name = user.name;
    if (Array.isArray(user.groups)) target.groups = user.groups;
    if (!target.lastSeen || user.lastSeen > target.lastSeen) target.lastSeen = user.lastSeen;
    for (const [modelId, windows] of Object.entries(user.models)) {
      if (!safeKey(modelId)) continue;
      if (!target.models[modelId] || typeof target.models[modelId] !== 'object') {
        target.models[modelId] = {};
      }
      for (const window of WINDOWS) {
        if (windows[window]) addWindow(target.models[modelId], window, windows[window]);
      }
    }
    for (const [appId, counter] of Object.entries(user.apps)) {
      if (safeKey(appId)) addWindow(target.apps, appId, counter);
    }
  }
}

function prune(data, now) {
  for (const [userKey, user] of Object.entries(data.users || {})) {
    const seen = Date.parse(user?.lastSeen);
    if (!Number.isFinite(seen) || now - seen > PRUNE_AFTER_MS) delete data.users[userKey];
  }
}

/**
 * @param {Object} [options]
 * @param {string} [options.filePath]
 * @param {number} [options.flushIntervalMs]
 */
export function createQuotaLedger({
  filePath = getContentsPath('data', 'quota-usage.json'),
  flushIntervalMs = FLUSH_INTERVAL_MS
} = {}) {
  const file = createSharedJsonFile({ filePath, createDefault, component: COMPONENT });
  let pending = createDefault();
  let dirty = false;
  let timer = null;
  let inFlight = null;

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) await inFlight.catch(() => {});
    if (!dirty) return;
    const delta = pending;
    pending = createDefault();
    dirty = false;
    const op = file.update(data => {
      mergeInto(data, delta);
      prune(data, Date.now());
    });
    inFlight = op;
    try {
      await op;
    } catch (error) {
      mergeInto(pending, delta);
      dirty = true;
      scheduleFlush();
      logger.error('Failed to save quota usage', { component: COMPONENT, error });
    } finally {
      if (inFlight === op) inFlight = null;
    }
  }

  /**
   * Count tokens for a user.
   *
   * @param {string} userKey
   * @param {Object} usage
   * @param {string} usage.modelId
   * @param {string} [usage.appId]
   * @param {number} usage.tokens
   * @param {Object} usage.windows - `currentWindows()` of the reset schedule
   * @param {string} [usage.name] - Display name for the admin views
   * @param {string[]} [usage.groups] - Groups at the time, for the admin views
   */
  function record(userKey, { modelId, appId, tokens, windows, name, groups }) {
    const amount = Math.max(0, Math.round(Number(tokens) || 0));
    if (!safeKey(userKey) || !safeKey(modelId) || amount === 0) return;
    const user = ensureUser(pending.users, userKey);
    if (name) user.name = String(name).slice(0, 200);
    if (Array.isArray(groups)) user.groups = groups.slice(0, 50).map(String);
    user.lastSeen = new Date().toISOString();
    if (!user.models[modelId]) user.models[modelId] = {};
    for (const window of WINDOWS) {
      addWindow(user.models[modelId], window, { key: windows[window].key, tokens: amount });
    }
    if (safeKey(appId)) addWindow(user.apps, appId, { key: windows.month.key, tokens: amount });
    dirty = true;
    scheduleFlush();
  }

  /** The file's data with this worker's pending counts added. */
  async function snapshot() {
    let data;
    try {
      data = structuredClone(await file.read());
    } catch (error) {
      logger.warn('Could not read quota usage', { component: COMPONENT, error: error.message });
      data = createDefault();
    }
    if (dirty) mergeInto(data, structuredClone(pending));
    if (!data.users || typeof data.users !== 'object') data.users = {};
    return data;
  }

  /**
   * Current-window token counts of one stored user entry.
   *
   * @param {Object|undefined} entry
   * @param {Object} windows - `currentWindows()`
   * @returns {{models: Object<string, {day:number, week:number, month:number}>,
   *   allModels: {day:number, week:number, month:number}, apps: Object<string, number>,
   *   name?: string, lastSeen?: string}}
   */
  function countsOf(entry, windows) {
    const allModels = { day: 0, week: 0, month: 0 };
    const models = {};
    for (const [modelId, counters] of Object.entries(entry?.models || {})) {
      const counts = {};
      for (const window of WINDOWS) {
        const counter = counters?.[window];
        counts[window] =
          counter && counter.key === windows[window].key ? Number(counter.tokens) || 0 : 0;
        allModels[window] += counts[window];
      }
      models[modelId] = counts;
    }
    const apps = {};
    for (const [appId, counter] of Object.entries(entry?.apps || {})) {
      if (counter?.key === windows.month.key) apps[appId] = Number(counter.tokens) || 0;
    }
    return {
      models,
      allModels,
      apps,
      name: entry?.name,
      groups: Array.isArray(entry?.groups) ? entry.groups : undefined,
      lastSeen: entry?.lastSeen
    };
  }

  async function getUser(userKey, windows) {
    const data = await snapshot();
    return countsOf(safeKey(userKey) ? data.users[userKey] : undefined, windows);
  }

  async function listUsers(windows) {
    const data = await snapshot();
    return Object.entries(data.users).map(([userKey, entry]) => ({
      userKey,
      ...countsOf(entry, windows)
    }));
  }

  /**
   * Set a user's current-window counts to zero.
   *
   * @param {string} userKey
   * @param {Object} windows - `currentWindows()`
   * @param {Object} [scope]
   * @param {string} [scope.modelId] - Only this model (all models when omitted)
   * @param {'day'|'week'|'month'} [scope.window] - Only this window (all when omitted)
   */
  async function reset(userKey, windows, { modelId, window } = {}) {
    if (!safeKey(userKey)) return;
    await flush();
    const targets = window ? [window] : WINDOWS;
    await file.update(data => {
      const user = data.users?.[userKey];
      if (!user?.models) return;
      for (const [id, counters] of Object.entries(user.models)) {
        if (modelId && id !== modelId) continue;
        for (const w of targets) counters[w] = { key: windows[w].key, tokens: 0 };
      }
    });
  }

  return { record, getUser, listUsers, reset, flush };
}

let defaultLedger = null;

/** The ledger of this process. */
export function getQuotaLedger() {
  if (!defaultLedger) defaultLedger = createQuotaLedger();
  return defaultLedger;
}

/** For tests: replace the process ledger. */
export function setQuotaLedger(ledger) {
  defaultLedger = ledger;
}
