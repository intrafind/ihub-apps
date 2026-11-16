// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Live token counters for usage limits: per user × model × window.
 *
 * Kept apart from the usage analytics (services/usage) on purpose: limits need
 * the real user (analytics may pseudonymize it) and the current numbers
 * (analytics are aggregated per day). Only counts are stored, no content.
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
 * In cluster mode the primary holds the counters (`createQuotaLedger`): workers
 * send what they counted over the cluster bus every 250 ms
 * (`createRemoteQuotaLedger`) and only the primary writes the file, every 3 s,
 * still under a lock and merged into what is there (utils/sharedJsonFile.js),
 * so several pods can share it. A limit check reads the file — parsed again
 * only after the primary wrote it — plus what the worker has not sent yet, and
 * copies only that user. Without a channel to the primary a process counts into
 * the file itself.
 *
 * @module services/quota/QuotaLedger
 */
import cluster from 'node:cluster';
import { isClusterBusActive, request, respondInPrimary } from '../../clusterBus.js';
import { createSharedJsonFile } from '../../utils/sharedJsonFile.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import logger from '../../utils/logger.js';
import { WINDOWS } from './resetSchedule.js';

const COMPONENT = 'QuotaLedger';
const FLUSH_INTERVAL_MS = 3000;
/** How long a worker collects counts before sending them to the primary. */
const SEND_INTERVAL_MS = 250;
/** How long a hand-over, an admin read or a reset waits for the primary. */
const ADMIN_TIMEOUT_MS = 5000;
const CHANNELS = Object.freeze({
  delta: 'quota:delta',
  list: 'quota:list',
  reset: 'quota:reset'
});
/** Users not seen for this long are dropped from the file. */
const PRUNE_AFTER_MS = 400 * 24 * 60 * 60 * 1000;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeKey(key) {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key);
}

function createDefault() {
  return { version: 1, users: {} };
}

/**
 * Add counter `delta` (`{key, tokens, at}`) to `target[name]`.
 *
 * Same window: the tokens add up. Different windows: the one recorded later
 * wins, not the one with the later key — after an admin moves the reset
 * schedule earlier, the current window's key is smaller than the stored one,
 * and it must still replace it. A worker's delta from before a reset, flushed
 * after another worker already counted in the new window, is older and is
 * dropped.
 */
function addWindow(target, name, delta) {
  const current = target[name];
  if (!current || typeof current !== 'object' || !current.key) {
    target[name] = { key: delta.key, tokens: delta.tokens, at: delta.at };
    return;
  }
  if (current.key === delta.key) {
    current.tokens = (Number(current.tokens) || 0) + delta.tokens;
    if (!current.at || (delta.at && delta.at > current.at)) current.at = delta.at;
    return;
  }
  const newer =
    current.at && delta.at ? delta.at > current.at : String(delta.key) > String(current.key);
  if (newer) target[name] = { key: delta.key, tokens: delta.tokens, at: delta.at };
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

/**
 * Count tokens for a user into `target` (the shape of the file).
 *
 * @returns {boolean} Whether anything was counted.
 */
function recordInto(target, userKey, { modelId, appId, tokens, windows, name, groups, now }) {
  const amount = Math.max(0, Math.round(Number(tokens) || 0));
  if (!safeKey(userKey) || !safeKey(modelId) || amount === 0) return false;
  const user = ensureUser(target.users, userKey);
  if (name) user.name = String(name).slice(0, 200);
  if (Array.isArray(groups)) user.groups = groups.slice(0, 50).map(String);
  user.lastSeen = new Date().toISOString();
  if (!user.models[modelId]) user.models[modelId] = {};
  const at = new Date(now ?? Date.now()).toISOString();
  for (const window of WINDOWS) {
    addWindow(user.models[modelId], window, { key: windows[window].key, tokens: amount, at });
  }
  if (safeKey(appId)) {
    addWindow(user.apps, appId, { key: windows.month.key, tokens: amount, at });
  }
  return true;
}

/** `entry` with `extra` (a pending entry of the same user) added, without touching either. */
function withPending(entry, extra) {
  if (!extra) return entry;
  const merged = { users: { u: structuredClone(entry ?? {}) } };
  mergeInto(merged, { users: { u: extra } });
  return merged.users.u;
}

function isEmpty(delta) {
  return Object.keys(delta.users).length === 0;
}

function prune(data, now) {
  for (const [userKey, user] of Object.entries(data.users || {})) {
    const seen = Date.parse(user?.lastSeen);
    if (!Number.isFinite(seen) || now - seen > PRUNE_AFTER_MS) delete data.users[userKey];
  }
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
  /** Flushes started so far; a read compares it before and after. */
  let flushCount = 0;

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
    flushCount += 1;
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
   * @param {Date|number} [usage.now] - When it was used (tests)
   */
  function record(userKey, usage) {
    if (!recordInto(pending, userKey, usage)) return;
    dirty = true;
    scheduleFlush();
  }

  /** Add counts another process collected (the primary, for its workers). */
  function absorb(delta) {
    if (!delta?.users || typeof delta.users !== 'object') return;
    mergeInto(pending, delta);
    dirty = true;
    scheduleFlush();
  }

  /**
   * The file's data with this worker's pending counts added.
   *
   * A flush moves its counts out of `pending` before they are in the file, so
   * a read that overlaps one would miss them: wait until no flush is running
   * (a flush queued behind the one just finished starts in between, so look
   * again), then read, and read again when one started during the read.
   */
  async function snapshot() {
    for (;;) {
      while (inFlight) await inFlight.catch(() => {});
      const startedFlushes = flushCount;
      let data;
      try {
        data = structuredClone(await file.read());
      } catch (error) {
        logger.warn('Could not read quota usage', { component: COMPONENT, error: error.message });
        data = createDefault();
      }
      if (startedFlushes !== flushCount) continue;
      if (dirty) mergeInto(data, structuredClone(pending));
      if (!data.users || typeof data.users !== 'object') data.users = {};
      return data;
    }
  }

  /**
   * One user's stored entry with this process's pending counts added. Reads
   * the cached file (re-read only when someone wrote it) and copies just this
   * user, never the whole file: this runs on every limited chat request.
   */
  async function readEntry(userKey) {
    if (!safeKey(userKey)) return undefined;
    for (;;) {
      while (inFlight) await inFlight.catch(() => {});
      const startedFlushes = flushCount;
      let data;
      try {
        data = await file.read();
      } catch (error) {
        logger.warn('Could not read quota usage', { component: COMPONENT, error: error.message });
        data = createDefault();
      }
      if (startedFlushes !== flushCount) continue;
      return withPending(data.users?.[userKey], dirty ? pending.users[userKey] : undefined);
    }
  }

  async function getUser(userKey, windows) {
    return countsOf(await readEntry(userKey), windows);
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
        const at = new Date().toISOString();
        for (const w of targets) counters[w] = { key: windows[w].key, tokens: 0, at };
      }
    });
  }

  return { record, absorb, readEntry, getUser, listUsers, reset, flush };
}

/**
 * A cluster worker's ledger: counts go to the primary in batches, reads ask the
 * primary. Without a channel to the primary it counts into the file through
 * `local` — the single-process ledger — and reads it from there.
 *
 * A batch is handed to the IPC channel and not resent: a channel to a live
 * primary does not drop messages, so a missing answer means a slow primary, and
 * resending would count the batch twice. Only the final batch at shutdown waits
 * for the primary and, without an answer, is written to the file.
 *
 * @param {Object} [options]
 * @param {Object} [options.local] - Fallback ledger (`createQuotaLedger`)
 * @param {Function} [options.ask] - `request` of the cluster bus (tests)
 * @param {Function} [options.isActive] - Whether the bus is up (tests)
 * @param {Function} [options.isConnected] - Whether the channel to the primary is open (tests)
 * @param {number} [options.sendIntervalMs]
 */
export function createRemoteQuotaLedger({
  local = createQuotaLedger(),
  ask = request,
  isActive = isClusterBusActive,
  isConnected = () => process.connected === true,
  sendIntervalMs = SEND_INTERVAL_MS
} = {}) {
  let unsent = createDefault();
  let timer = null;

  const reachable = () => isActive() && isConnected();

  function scheduleSend() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void send();
    }, sendIntervalMs);
    timer.unref?.();
  }

  /**
   * Hand what was counted to the primary. Synchronous up to the hand-over, so
   * a question asked right after it is answered with these counts included:
   * the channel delivers in order and the primary counts a batch as it arrives.
   *
   * @param {Object} [options]
   * @param {boolean} [options.final] - Shutdown: wait for the primary, and
   *   write the batch to the file when it does not answer.
   */
  async function send({ final = false } = {}) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (isEmpty(unsent)) return;
    const batch = unsent;
    unsent = createDefault();
    if (reachable()) {
      const answer = ask(CHANNELS.delta, batch, {
        timeoutMs: ADMIN_TIMEOUT_MS,
        primaryOnly: true
      });
      if (!final) return;
      if ((await answer)?.ok) return;
    }
    local.absorb(batch);
  }

  function record(userKey, usage) {
    if (recordInto(unsent, userKey, usage)) scheduleSend();
  }

  /**
   * A user's counts for a limit check: the file and what this worker has not
   * sent yet. No question to the primary — under load its message queue can
   * take longer than a chat should wait — so counts the primary has not
   * written yet (at most one write interval) are missing from the check.
   */
  async function getUser(userKey, windows) {
    if (!safeKey(userKey)) return countsOf(undefined, windows);
    const entry = await local.readEntry(userKey);
    return countsOf(withPending(entry, unsent.users[userKey]), windows);
  }

  async function listUsers(windows) {
    await send();
    const reply = reachable()
      ? await ask(CHANNELS.list, { windows }, { timeoutMs: ADMIN_TIMEOUT_MS, primaryOnly: true })
      : null;
    return Array.isArray(reply?.users) ? reply.users : local.listUsers(windows);
  }

  async function reset(userKey, windows, scope = {}) {
    await send();
    const reply = reachable()
      ? await ask(
          CHANNELS.reset,
          { userKey, windows, scope },
          { timeoutMs: ADMIN_TIMEOUT_MS, primaryOnly: true }
        )
      : null;
    if (!reply?.ok) await local.reset(userKey, windows, scope);
  }

  /** Shutdown: the last batch, and whatever went to the file path before it. */
  async function flush() {
    await send({ final: true });
    await local.flush();
  }

  return { record, getUser, listUsers, reset, flush };
}

let defaultLedger = null;

/**
 * The ledger of this process: the primary's (or a single process's) own, or a
 * cluster worker's remote one.
 */
export function getQuotaLedger() {
  if (!defaultLedger) {
    defaultLedger = cluster.isWorker ? createRemoteQuotaLedger() : createQuotaLedger();
  }
  return defaultLedger;
}

if (cluster.isPrimary) {
  // Answers only arrive here in cluster mode; a single process never asks.
  respondInPrimary(CHANNELS.delta, delta => {
    getQuotaLedger().absorb(delta);
    return { ok: true };
  });
  respondInPrimary(CHANNELS.list, async ({ windows } = {}) => ({
    users: await getQuotaLedger().listUsers(windows)
  }));
  respondInPrimary(CHANNELS.reset, async ({ userKey, windows, scope } = {}) => {
    await getQuotaLedger().reset(userKey, windows, scope);
    return { ok: true };
  });
}

/** For tests: replace the process ledger. */
export function setQuotaLedger(ledger) {
  defaultLedger = ledger;
}
