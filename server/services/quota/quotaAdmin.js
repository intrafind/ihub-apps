// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin views of usage limits: every user with their buckets, and the
 * same numbers per model and per group.
 *
 * Users are those in users.json plus everyone the quota ledger has counted
 * (external sign-ins that are never stored, guests). The groups of a stored
 * user come from users.json; of anyone else from the ledger's snapshot taken
 * at their last model call.
 *
 * @module services/quota/quotaAdmin
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import {
  enhanceUserGroups,
  enhanceUserWithPermissions,
  getDefaultAnonymousGroups
} from '../../utils/authorization.js';
import { getChatFileRepository } from '../chatFiles/ChatFileRepository.js';
import { GUEST_OWNER_PREFIX, resolveChatOwner } from '../chat/chatOwner.js';
import runLog from '../loop/RunLog.js';
import { WINDOWS } from './resetSchedule.js';
import { isLimited } from './limitResolver.js';
import { getQuotaLedger } from './QuotaLedger.js';
import {
  buildBuckets,
  getCurrentWindows,
  getUserLimits,
  usersMap,
  WARNING_THRESHOLD
} from './quotaService.js';

const COMPONENT = 'QuotaAdmin';

function platform() {
  return configCache.getPlatform?.() || {};
}

function models() {
  return configCache.getModels?.(true)?.data || [];
}

function groupsMap() {
  return configCache.getGroups?.()?.data?.groups || {};
}

function isGuestKey(userKey) {
  return userKey === 'anonymous' || userKey.startsWith(GUEST_OWNER_PREFIX);
}

/**
 * A principal for `userKey` good enough to resolve limits: id, groups and
 * the permissions those groups give.
 */
export function principalFor(userKey, { record = null, ledgerEntry = null } = {}) {
  const config = platform();
  if (isGuestKey(userKey)) {
    const user = { id: 'anonymous', groups: [...getDefaultAnonymousGroups(config)] };
    return enhanceUserWithPermissions(user, config.auth || {}, config);
  }
  let groups;
  if (record) {
    const internal = Array.isArray(record.internalGroups)
      ? record.internalGroups.map(String)
      : Array.isArray(record.groups)
        ? record.groups.map(String)
        : ['users'];
    groups = enhanceUserGroups({ id: userKey, groups: internal }, config.auth || {}).groups;
  } else if (Array.isArray(ledgerEntry?.groups)) {
    groups = [...ledgerEntry.groups];
  } else {
    groups = ['authenticated'];
  }
  const user = {
    id: userKey,
    name: record?.name || record?.fullName || ledgerEntry?.name || null,
    groups
  };
  return enhanceUserWithPermissions(user, config.auth || {}, config);
}

function displayOf(userKey, record, entry) {
  if (isGuestKey(userKey)) return { name: 'Guest', username: null, email: null, guest: true };
  return {
    name: record?.name || record?.fullName || entry?.name || record?.username || userKey,
    username: record?.username || null,
    email: record?.email || null,
    guest: false
  };
}

async function fileUsageFor(user) {
  try {
    const repository = getChatFileRepository();
    if (!repository.isAvailable()) return null;
    const owner = await resolveChatOwner(user, { mode: runLog.identityMode() });
    if (!owner) return null;
    return await repository.getOwnerUsage(owner.id);
  } catch (error) {
    logger.warn('Could not read file usage', { component: COMPONENT, error: error.message });
    return null;
  }
}

function worstOf(buckets) {
  let worst = null;
  for (const b of buckets) if (!worst || b.percent > worst.percent) worst = b;
  return worst;
}

function statusOf(buckets) {
  if (buckets.some(b => b.exceeded)) return 'exceeded';
  if (buckets.some(b => b.warning)) return 'warning';
  return 'ok';
}

/** Every known user with their current usage and limits (no file usage). */
async function collectUsers() {
  const windows = getCurrentWindows();
  const allModels = models();
  const users = usersMap();
  const ledgerUsers = await getQuotaLedger().listUsers(windows);
  const byKey = new Map(ledgerUsers.map(entry => [entry.userKey, entry]));
  const keys = new Set([...Object.keys(users), ...byKey.keys()]);
  const empty = { models: {}, allModels: { day: 0, week: 0, month: 0 }, apps: {} };
  const rows = [];
  for (const userKey of keys) {
    const record = Object.hasOwn(users, userKey) ? users[userKey] : null;
    if (record && (record.active === false || record.enabled === false)) {
      if (!byKey.has(userKey)) continue;
    }
    const entry = byKey.get(userKey) || null;
    const principal = principalFor(userKey, { record, ledgerEntry: entry });
    const limits = getUserLimits(principal, { models: allModels, users });
    const counts = entry || empty;
    const buckets = buildBuckets({ limits, counts, windows, models: allModels });
    rows.push({ userKey, record, entry, principal, limits, counts, buckets, windows });
  }
  return rows;
}

function summarize(row) {
  const display = displayOf(row.userKey, row.record, row.entry);
  const worst = worstOf(row.buckets);
  return {
    userKey: row.userKey,
    ...display,
    groups: row.principal.groups || [],
    lastSeen: row.entry?.lastSeen || null,
    tokens: row.counts.allModels,
    status: statusOf(row.buckets),
    worst,
    buckets: row.buckets,
    hasPersonalLimits: Boolean(row.record?.usageLimits),
    // Only users in users.json have an editor (and can hold personal limits).
    stored: Boolean(row.record),
    fileLimit: Number.isFinite(row.limits.fileStorageBytes.limit)
      ? row.limits.fileStorageBytes.limit
      : null
  };
}

/**
 * One page of the user table.
 *
 * @param {Object} [query]
 * @param {string} [query.search]
 * @param {'all'|'warning'|'exceeded'|'limited'} [query.status]
 * @param {string} [query.modelId] - Only users with a bucket of this model
 * @param {number} [query.page] - 1-based
 * @param {number} [query.pageSize]
 */
export async function listQuotaUsers({
  search = '',
  status = 'all',
  modelId = null,
  page = 1,
  pageSize = 25
} = {}) {
  const needle = String(search || '')
    .trim()
    .toLowerCase();
  let rows = (await collectUsers()).map(row => ({ row, summary: summarize(row) }));
  if (needle) {
    rows = rows.filter(({ summary }) =>
      [summary.userKey, summary.name, summary.username, summary.email, ...summary.groups]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(needle))
    );
  }
  if (modelId)
    rows = rows.filter(({ summary }) => summary.buckets.some(b => b.modelId === modelId));
  if (status === 'exceeded') rows = rows.filter(({ summary }) => summary.status === 'exceeded');
  else if (status === 'warning') rows = rows.filter(({ summary }) => summary.status !== 'ok');
  else if (status === 'limited') rows = rows.filter(({ summary }) => summary.buckets.length > 0);

  // Most urgent first, then the heaviest users.
  const rank = { exceeded: 2, warning: 1, ok: 0 };
  rows.sort(
    (a, b) =>
      rank[b.summary.status] - rank[a.summary.status] ||
      (b.summary.worst?.percent || 0) - (a.summary.worst?.percent || 0) ||
      (b.summary.tokens.month || 0) - (a.summary.tokens.month || 0)
  );

  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const total = rows.length;
  const current = Math.max(Number(page) || 1, 1);
  const slice = rows.slice((current - 1) * size, current * size);
  const items = await Promise.all(
    slice.map(async ({ row, summary }) => {
      const files =
        row.userKey && !isGuestKey(row.userKey) ? await fileUsageFor(row.principal) : null;
      return { ...summary, files: files ? { ...files, limit: summary.fileLimit } : null };
    })
  );
  return { items, total, page: current, pageSize: size };
}

/**
 * One user in detail: buckets, per-model and per-app usage, file storage and
 * where each limit came from.
 */
export async function getQuotaUser(userKey) {
  const rows = await collectUsers();
  const row = rows.find(r => r.userKey === userKey);
  if (!row) return null;
  const summary = summarize(row);
  const byId = new Map(models().map(m => [m.id, m]));
  const modelRows = Object.keys(row.limits.models).map(modelId => ({
    modelId,
    name: byId.get(modelId)?.name || modelId,
    usage: row.counts.models[modelId] || { day: 0, week: 0, month: 0 },
    limits: Object.fromEntries(
      WINDOWS.map(w => {
        const e = row.limits.models[modelId][w];
        return [w, { limit: Number.isFinite(e.limit) ? e.limit : null, source: e.source }];
      })
    )
  }));
  const files = isGuestKey(userKey) ? null : await fileUsageFor(row.principal);
  return {
    ...summary,
    personalLimits: row.record?.usageLimits || null,
    stored: Boolean(row.record),
    models: modelRows,
    apps: Object.entries(row.counts.apps || {})
      .map(([appId, tokens]) => ({ appId, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    files: files ? { ...files, limit: summary.fileLimit } : null
  };
}

/** Per model: its global limits and how its users stand against their budgets. */
export async function getModelOverview() {
  const rows = await collectUsers();
  return models()
    .filter(m => m.enabled !== false)
    .map(model => {
      const totals = { day: 0, week: 0, month: 0 };
      let activeUsers = 0;
      let warning = 0;
      let exceeded = 0;
      for (const row of rows) {
        const usage = row.counts.models?.[model.id];
        if (usage?.month) activeUsers++;
        for (const w of WINDOWS) totals[w] += usage?.[w] || 0;
        const buckets = row.buckets.filter(b => b.modelId === model.id);
        if (buckets.some(b => b.exceeded)) exceeded++;
        else if (buckets.some(b => b.warning)) warning++;
      }
      const ceiling = {};
      for (const w of WINDOWS) {
        const v = model.usageLimits?.[w];
        ceiling[w] = typeof v === 'number' && v >= 0 ? v : null;
      }
      return {
        modelId: model.id,
        name: model.name,
        limits: ceiling,
        limited: WINDOWS.some(w => ceiling[w] !== null),
        tokens: totals,
        activeUsers,
        usersWarning: warning,
        usersExceeded: exceeded
      };
    })
    .sort((a, b) => b.tokens.month - a.tokens.month);
}

/** Per group: its own limits and its members' combined usage. */
export async function getGroupOverview() {
  const rows = await collectUsers();
  const groups = groupsMap();
  return Object.entries(groups).map(([groupId, group]) => {
    const members = rows.filter(r => (r.principal.groups || []).includes(groupId));
    const tokens = { day: 0, week: 0, month: 0 };
    let warning = 0;
    let exceeded = 0;
    for (const row of members) {
      for (const w of WINDOWS) tokens[w] += row.counts.allModels?.[w] || 0;
      const status = statusOf(row.buckets);
      if (status === 'exceeded') exceeded++;
      else if (status === 'warning') warning++;
    }
    return {
      groupId,
      name: group.name || groupId,
      usageLimits: group.usageLimits || null,
      inherits: group.inherits || [],
      members: members.length,
      tokens,
      usersWarning: warning,
      usersExceeded: exceeded
    };
  });
}

export { WARNING_THRESHOLD, isLimited };
