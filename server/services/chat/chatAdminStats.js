/**
 * Chat statistics for the admin Chat History page — what is stored, who it
 * belongs to, and what the next retention sweep would take.
 *
 * Read-only, and deliberately built on the same reads the sweep uses: one walk
 * of the `chats` namespace, deciding each document as it arrives and keeping
 * only per-owner and per-app counters. An admin asking "how much would a 30-day
 * window remove?" gets the answer the sweep would act on, not an estimate from
 * a different query.
 *
 * Only chat documents are read — never transcripts. The counts come from the
 * metadata a chat already carries (`messageCount`, `lastMessageAt`, `status`,
 * `appId`), so the page never loads a conversation to count it.
 *
 * @module services/chat/chatAdminStats
 */
import { CHATS_NAMESPACE } from './ChatRepository.js';

/** One day in milliseconds — the unit `retentionDays` is expressed in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Documents fetched per `list` call on a provider that cannot stream. */
const SCAN_PAGE_SIZE = 200;

/**
 * Chats read before the walk stops and reports itself truncated. A bound that
 * cut the count short is reported rather than hidden: a partial number read as
 * a complete one is worse than no number.
 */
export const MAX_SCANNED_CHATS = 100_000;

/** Entries kept in the "top apps" and "top users" lists. */
const TOP_N = 10;

/**
 * A chat is "near" the message cap once it holds this fraction of it — the
 * point at which an admin raising the cap still helps the people typing.
 */
const NEAR_CAP_RATIO = 0.9;

/**
 * When a chat last saw activity. Same precedence the retention sweep uses, so
 * "would expire" here means what the sweep means by it.
 *
 * @param {Object} doc - Document from the store.
 * @returns {number} Milliseconds since the epoch, or `NaN` when unknown.
 */
function activityTime(doc) {
  const candidates = [doc?.data?.lastMessageAt, doc?.data?.createdAt, doc?.updatedAt];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/**
 * Walk every chat document once, newest code path first.
 *
 * @param {import('../../storage/DocumentStore.js').DocumentStore} documents
 * @param {number} pageSize - Page size for the paged fallback.
 * @returns {AsyncGenerator<Object>}
 */
async function* walkChats(documents, pageSize) {
  if (documents.supportsScan) {
    yield* documents.scan(CHATS_NAMESPACE);
    return;
  }
  let cursor = null;
  do {
    const page = await documents.list(CHATS_NAMESPACE, {
      limit: pageSize,
      ...(cursor ? { cursor } : {})
    });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor);
}

/**
 * The `n` largest entries of a counter map, largest first, ties on key.
 *
 * @param {Map<string, {chats: number, messages: number}>} counters
 * @param {string} keyName - Property name for the key in the output.
 * @param {number} n - Entries kept.
 * @returns {Object[]}
 */
function topEntries(counters, keyName, n) {
  return [...counters.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      if (left.chats !== right.chats) return right.chats - left.chats;
      return leftKey < rightKey ? -1 : 1;
    })
    .slice(0, n)
    .map(([key, value]) => ({ [keyName]: key, ...value }));
}

/**
 * An empty result, for a store that is not there.
 *
 * @returns {Object}
 */
function emptyStats() {
  return {
    available: false,
    totalChats: 0,
    totalMessages: 0,
    totalUsers: 0,
    scanned: 0,
    truncated: false,
    byStatus: {},
    activeLast24h: 0,
    activeLast7d: 0,
    oldestActivityAt: null,
    newestActivityAt: null,
    topApps: [],
    topUsers: [],
    retention: {
      expiringByAge: 0,
      usersOverQuota: 0,
      chatsOverQuota: 0,
      chatsAtMessageCap: 0,
      chatsNearMessageCap: 0
    }
  };
}

/**
 * Collect statistics over every stored chat.
 *
 * @param {Object} options
 * @param {import('./ChatRepository.js').ChatRepository} options.repository -
 *   Chat repository; an unavailable one yields `available: false`.
 * @param {{retentionDays: number, maxChatsPerUser: number, maxMessagesPerChat: number}} options.settings -
 *   Retention settings in force; each rule is off at zero or less.
 * @param {() => number} [options.now] - Clock, for tests.
 * @param {number} [options.maxScanned] - Walk bound, for tests.
 * @param {number} [options.pageSize] - Page size for the paged fallback.
 * @returns {Promise<Object>} Counts; see {@link emptyStats} for the shape.
 */
export async function collectChatStats({
  repository,
  settings,
  now = Date.now,
  maxScanned = MAX_SCANNED_CHATS,
  pageSize = SCAN_PAGE_SIZE
} = {}) {
  const stats = emptyStats();
  if (!repository || typeof repository.isAvailable !== 'function' || !repository.isAvailable()) {
    return stats;
  }
  const documents = repository.documents;
  stats.available = true;

  const { retentionDays = 0, maxChatsPerUser = 0, maxMessagesPerChat = 0 } = settings || {};
  const nowMs = now();
  const cutoff = retentionDays > 0 ? nowMs - retentionDays * DAY_MS : null;
  const nearCap = maxMessagesPerChat > 0 ? Math.ceil(maxMessagesPerChat * NEAR_CAP_RATIO) : null;

  const byOwner = new Map();
  const byApp = new Map();
  // Chats per owner that survive the age rule — the population the count
  // rule is applied to, since the sweep runs the age rule first.
  const survivorsByOwner = new Map();
  let oldest = Infinity;
  let newest = -Infinity;

  for await (const doc of walkChats(documents, pageSize)) {
    if (stats.scanned >= maxScanned) {
      stats.truncated = true;
      break;
    }
    stats.scanned += 1;
    const chat = doc?.data || {};
    const messages = Number.isFinite(chat.messageCount) ? chat.messageCount : 0;
    const ownerId = chat.ownerId ?? doc.ownerId ?? null;
    const activeAt = activityTime(doc);

    stats.totalChats += 1;
    stats.totalMessages += messages;
    const status = chat.status || 'active';
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

    if (Number.isFinite(activeAt)) {
      if (activeAt < oldest) oldest = activeAt;
      if (activeAt > newest) newest = activeAt;
      if (nowMs - activeAt <= DAY_MS) stats.activeLast24h += 1;
      if (nowMs - activeAt <= 7 * DAY_MS) stats.activeLast7d += 1;
    }

    if (ownerId) {
      const owner = byOwner.get(ownerId) || { chats: 0, messages: 0 };
      owner.chats += 1;
      owner.messages += messages;
      byOwner.set(ownerId, owner);
    }
    const appId = chat.appId || null;
    if (appId) {
      const app = byApp.get(appId) || { chats: 0, messages: 0 };
      app.chats += 1;
      app.messages += messages;
      byApp.set(appId, app);
    }

    if (nearCap !== null) {
      if (messages >= maxMessagesPerChat) stats.retention.chatsAtMessageCap += 1;
      else if (messages >= nearCap) stats.retention.chatsNearMessageCap += 1;
    }

    const expires = cutoff !== null && Number.isFinite(activeAt) && activeAt < cutoff;
    if (expires) {
      stats.retention.expiringByAge += 1;
    } else if (ownerId) {
      survivorsByOwner.set(ownerId, (survivorsByOwner.get(ownerId) || 0) + 1);
    }
  }

  stats.totalUsers = byOwner.size;
  if (maxChatsPerUser > 0) {
    for (const count of survivorsByOwner.values()) {
      if (count <= maxChatsPerUser) continue;
      stats.retention.usersOverQuota += 1;
      stats.retention.chatsOverQuota += count - maxChatsPerUser;
    }
  }
  stats.oldestActivityAt = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
  stats.newestActivityAt = Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  stats.topApps = topEntries(byApp, 'appId', TOP_N);
  stats.topUsers = topEntries(byOwner, 'ownerId', TOP_N);
  return stats;
}
