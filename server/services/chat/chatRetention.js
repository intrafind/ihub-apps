/**
 * Chat retention — the daily sweep that keeps durable chats from growing
 * without bound.
 *
 * Two rules, both configured under `platform.chats` and both switched off by a
 * value of zero or less:
 *   - **age** — a chat whose last message is older than `retentionDays` goes.
 *   - **count** — an owner keeps only their `maxChatsPerUser` most recent
 *     chats; the rest go, oldest first.
 *
 * A removal is the same cascade `DELETE /api/chats/:id` performs, and through
 * the same function: the chat document, its transcript, and then
 * `deleteChatWithCascade` for every run the chat recorded — the run's ledger
 * file, its spill directory, its pending interactions, and the workflow state
 * of an `@mention` turn. The chat document is the only place a chat's run ids
 * are written down, so the cascade has to run here rather than being left to
 * the ledger's own retention.
 *
 * Scanning: `DocumentStore.list` is index-backed per owner and key-ordered
 * otherwise, so the two rules are read differently. The age rule pages the
 * whole `chats` namespace and decides each document as it arrives, holding
 * only the ids it condemned and the set of owners whose chats survived. The
 * count rule then asks the owner index, one owner at a time.
 *
 * Nothing global is materialized, and that is not an optimization. The sweep
 * used to hold the namespace in memory behind a fixed 20,000-document ceiling,
 * which made the count rule self-defeating: listing is ascending by key and
 * chat ids are random uuids, so every tick saw the same lexicographic prefix
 * and the tail was permanently invisible to both rules — while the count rule
 * was the only thing keeping the namespace under that ceiling. A database-backed
 * provider will eventually answer both rules with a query and this module
 * should shrink to two of them.
 *
 * @module services/chat/chatRetention
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import runLog from '../loop/RunLog.js';
import { CHATS_NAMESPACE, getChatRepository } from './ChatRepository.js';
import { chatRetentionSettings, isChatPersistenceConfigured } from './chatPersistence.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import { getWorkflowStateRepository } from '../workflow/WorkflowStateRepository.js';
import { deleteChatWithCascade } from './chatDeletion.js';

const COMPONENT = 'ChatRetention';

/** One day in milliseconds — the sweep interval and the age unit. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Documents fetched per `list` call while scanning the namespace. */
const SCAN_PAGE_SIZE = 200;

/**
 * Chats read per owner when the count rule checks a quota.
 *
 * The rule keeps the `maxChatsPerUser` most recently active, so it has to see
 * that owner's chats — but only that owner's, through the index, one owner at
 * a time. Bounded because an owner over this many has more chats than the
 * quota can meaningfully rank; the oldest of what is read still goes, so the
 * count converges over successive ticks rather than stalling.
 */
const MAX_OWNER_CHATS = 2000;

/** The running sweep timer, so starting twice does not sweep twice. */
let sweepTimer = null;

/** Guards against a tick starting while the previous one is still running. */
let sweeping = false;

/**
 * The document facet behind a repository, or null when storage is unavailable.
 *
 * Retention is the one operation that needs to see every owner's chats at
 * once, which the repository's owner-scoped API deliberately does not offer —
 * so it reads the namespace through the same facet the repository writes it
 * with, rather than the repository growing a method only a sweep would call.
 *
 * @param {import('./ChatRepository.js').ChatRepository} [repository]
 * @returns {import('../../storage/DocumentStore.js').DocumentStore|null}
 */
function documentsOf(repository) {
  if (!repository || typeof repository.isAvailable !== 'function') return null;
  return repository.isAvailable() ? repository.documents : null;
}

/**
 * When a chat last saw activity, as a timestamp.
 *
 * `lastMessageAt` is the field the product sorts and expires on; `createdAt`
 * covers a chat created but never written to, and the document's own
 * `updatedAt` covers a document written by an older version of this code.
 * A chat with no usable timestamp is treated as brand new — never deleting
 * something whose age cannot be established is the safe direction.
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
 * Walk the whole `chats` namespace, applying the age rule as it goes.
 *
 * Nothing global is held. The walk keeps the ids the age rule condemned and
 * the set of owners whose chats survived it — one page at a time, and the
 * owner set is bounded by how many people use the installation rather than by
 * how many chats they have.
 *
 * It used to materialize the namespace and stop at a fixed 20,000, which made
 * the count rule self-defeating: `list` is ascending by key and chat ids are
 * random uuids, so every tick saw the same lexicographic prefix and the tail
 * was permanently invisible to *both* rules — while the count rule was the only
 * thing keeping the namespace under that ceiling in the first place. Past
 * equilibrium the visible fraction shrank, owners kept `maxChatsPerUser /
 * fraction` chats each, and disk grew without bound while both settings read
 * as configured.
 *
 * @param {import('../../storage/DocumentStore.js').DocumentStore} documents
 * @param {number|null} cutoff - Age cutoff in ms, or null when the age rule is off.
 * @returns {Promise<{expired: string[], owners: Set<string>, scanned: number}>}
 */
async function scanChats(documents, cutoff, pageSize) {
  const expired = [];
  const owners = new Set();
  let scanned = 0;
  let cursor = null;
  do {
    const page = await documents.list(CHATS_NAMESPACE, {
      limit: pageSize,
      ...(cursor ? { cursor } : {})
    });
    for (const doc of page.items) {
      scanned += 1;
      const activeAt = activityTime(doc);
      if (cutoff !== null && Number.isFinite(activeAt) && activeAt < cutoff) {
        expired.push(doc.key);
        continue;
      }
      // Only survivors count towards a quota, and only an owned chat counts at
      // all — an unowned one cannot be attributed to anybody's.
      const ownerId = doc.data?.ownerId ?? doc.ownerId ?? null;
      if (ownerId) owners.add(ownerId);
    }
    cursor = page.nextCursor;
  } while (cursor);

  return { expired, owners, scanned };
}

/**
 * The chats one owner has to give up to the count rule.
 *
 * Read through the owner index rather than out of a global scan, so the rule
 * sees that owner's chats whatever the size of the namespace around them.
 *
 * @param {import('../../storage/DocumentStore.js').DocumentStore} documents
 * @param {string} ownerId - Owner to check.
 * @param {number} maxChatsPerUser - Cap; zero or less disables the rule.
 * @param {number} pageSize - Documents per index read.
 * @returns {Promise<string[]>} Chat ids past the cap, oldest first.
 */
async function overflowingForOwner(documents, ownerId, maxChatsPerUser, pageSize) {
  if (!(maxChatsPerUser > 0)) return [];
  const owned = [];
  let cursor = null;
  do {
    const page = await documents.list(CHATS_NAMESPACE, {
      ownerId,
      limit: pageSize,
      ...(cursor ? { cursor } : {})
    });
    for (const doc of page.items) {
      // `ownerId` included because `overflowingChats` groups on it — an entry
      // without one is a chat it cannot attribute to a quota, and would skip.
      // No need to exclude what the age rule already took: that ran first and
      // its deletes removed the index entries, so a chat listed here is one
      // that is still stored.
      owned.push({ id: doc.key, ownerId, activeAt: activityTime(doc) });
    }
    cursor = page.nextCursor;
  } while (cursor && owned.length < MAX_OWNER_CHATS);
  if (owned.length <= maxChatsPerUser) return [];
  return overflowingChats(owned, maxChatsPerUser).map(chat => chat.id);
}

/**
 * Chats an owner has to give up to the count rule: everything past the
 * `maxChatsPerUser` most recently active.
 *
 * @param {Array<{id: string, ownerId: string|null, activeAt: number}>} chats -
 *   Chats that survived the age rule.
 * @param {number} maxChatsPerUser - Cap per owner; zero or less disables.
 * @returns {Array<{id: string, ownerId: string|null, activeAt: number}>}
 */
function overflowingChats(chats, maxChatsPerUser) {
  if (!(maxChatsPerUser > 0)) return [];
  const byOwner = new Map();
  for (const chat of chats) {
    // A chat with no owner cannot be attributed to anybody's quota. It is
    // still subject to the age rule; it just never counts against a cap.
    if (!chat.ownerId) continue;
    const owned = byOwner.get(chat.ownerId);
    if (owned) owned.push(chat);
    else byOwner.set(chat.ownerId, [chat]);
  }

  const overflow = [];
  for (const owned of byOwner.values()) {
    if (owned.length <= maxChatsPerUser) continue;
    // Newest first, ties broken on id so the same chat is dropped whichever
    // order the store handed the page back in.
    owned.sort((a, b) => {
      const left = Number.isFinite(a.activeAt) ? a.activeAt : 0;
      const right = Number.isFinite(b.activeAt) ? b.activeAt : 0;
      if (left !== right) return right - left;
      return a.id < b.id ? -1 : 1;
    });
    overflow.push(...owned.slice(maxChatsPerUser));
  }
  return overflow;
}

/**
 * Apply both retention rules once.
 *
 * @param {Object} options
 * @param {import('./ChatRepository.js').ChatRepository} options.repository -
 *   Chat repository; an unavailable one makes this a no-op.
 * @param {number} options.retentionDays - Age limit in days; zero or less
 *   keeps chats forever.
 * @param {number} options.maxChatsPerUser - Chats kept per owner; zero or less
 *   puts no cap on it.
 * @param {(runId: string) => Promise<unknown>} [options.deleteRun] - Ledger
 *   cascade for a removed chat's runs. Injectable so a test can observe it
 *   without a ledger on disk.
 * @param {(runId: string) => Promise<unknown>} [options.removeWorkflowState] -
 *   Workflow-state cascade, injectable for the same reason.
 * @param {number} [options.pageSize] - Documents per `list` call. Injectable
 *   so a test can drive the walk across page boundaries, which is where the
 *   ceiling this replaced used to lose the tail of the namespace.
 * @param {() => number} [options.now] - Clock, for tests.
 * @returns {Promise<{removed: number}>} How many chats were removed.
 */
export async function sweepChats({
  repository,
  retentionDays,
  maxChatsPerUser,
  deleteRun = runId => runLog.deleteRun(runId),
  removeWorkflowState = runId => getWorkflowStateRepository().remove(runId),
  pageSize = SCAN_PAGE_SIZE,
  now = Date.now
} = {}) {
  const documents = documentsOf(repository);
  if (!documents) return { removed: 0 };
  // Neither rule is on: skip the scan entirely rather than paging the whole
  // namespace every day to decide nothing.
  if (!(retentionDays > 0) && !(maxChatsPerUser > 0)) return { removed: 0 };

  const cutoff = retentionDays > 0 ? now() - retentionDays * DAY_MS : null;
  const { expired, owners, scanned } = await scanChats(documents, cutoff, pageSize);

  let removed = 0;
  /**
   * Remove one chat, isolated: a chat that refuses to go must not strand the
   * rest of the sweep, and there is no caller to report it to.
   *
   * @param {string} chatId - Chat to remove.
   * @returns {Promise<void>}
   */
  const remove = async chatId => {
    try {
      const { deleted } = await deleteChatWithCascade(repository, chatId, {
        deleteRun,
        removeWorkflowState,
        component: COMPONENT
      });
      if (deleted) removed += 1;
    } catch (error) {
      logger.error('Chat retention failed to remove a chat', {
        component: COMPONENT,
        chatId,
        error: error.message
      });
    }
  };

  for (const chatId of expired) await remove(chatId);

  // The count rule, per owner and off the index. Deliberately after the age
  // rule and told what it already took: an owner whose overflow was expired
  // anyway must not have live chats removed to make up the number.
  let byCount = 0;
  for (const ownerId of owners) {
    let overflow;
    try {
      overflow = await overflowingForOwner(documents, ownerId, maxChatsPerUser, pageSize);
    } catch (error) {
      logger.error('Chat retention failed to check an owner against the count rule', {
        component: COMPONENT,
        error: error.message
      });
      continue;
    }
    for (const chatId of overflow) {
      byCount += 1;
      await remove(chatId);
    }
  }

  if (removed > 0) {
    logger.info('Chat retention removed expired chats', {
      component: COMPONENT,
      removed,
      byAge: expired.length,
      byCount,
      scanned
    });
  }
  return { removed };
}

/**
 * Start the daily chat retention sweep.
 *
 * Idempotent, and must be started from the cluster singleton that already owns
 * `runLog.startCleanupScheduler()` — two workers sweeping in parallel would
 * race each other's deletes for no benefit. Runs once immediately so a
 * misconfigured retention is visible in the logs at boot rather than a day
 * later, then every `intervalMs`. The timer is `unref()`d: a pending sweep
 * never keeps the process alive.
 *
 * @param {Object} [options]
 * @param {import('./ChatRepository.js').ChatRepository} [options.repository] -
 *   Repository to sweep. Resolved per tick from the bootstrapped storage
 *   provider when omitted, so a sweep started before storage came up (or after
 *   a provider swap) still sees the live one.
 * @param {() => Object} [options.getFeatures] - Reads the feature flags.
 *   Injectable for the same reason as the platform reader below.
 * @param {() => boolean} [options.storageReady] - Storage-readiness probe, the
 *   third half of the same predicate the write path evaluates.
 * @param {() => Object} [options.getPlatformConfig] - Reads the platform
 *   config each tick, so an admin's change to `platform.chats` takes effect
 *   without a restart.
 * @param {number} [options.intervalMs=86400000] - Sweep interval.
 * @returns {() => void} Stops the sweep.
 */
export function startChatRetentionSweep({
  repository = null,
  getPlatformConfig = () => configCache.getPlatform?.() || {},
  getFeatures = () => configCache.getFeatures?.() || {},
  storageReady = isStorageReady,
  intervalMs = DAY_MS
} = {}) {
  if (sweepTimer) return stopChatRetentionSweep;

  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const platform = getPlatformConfig() || {};
      // Turning durable chats off must not delete what is already stored: an
      // admin flipping the switch is disabling a feature, not asking for a
      // purge. Retention only runs while chats are on.
      //
      // This is the same predicate the write path uses, deliberately. Gating
      // on `chats.enabled` alone read as "chats are on", but the switch an
      // admin actually sees is the `chatPersistence` feature — and it does not
      // touch `chats.enabled`. Turning the feature off therefore stopped
      // writes while leaving this sweep running: no chat's `lastMessageAt`
      // could advance again, so every stored chat was guaranteed to cross the
      // cutoff, and the REST surface was already 503 so nobody could export or
      // delete one first. Ninety days later the sweep deleted all of them.
      if (!isChatPersistenceConfigured(getFeatures() || {}, platform, storageReady)) return;
      const { retentionDays, maxChatsPerUser } = chatRetentionSettings(platform);
      await sweepChats({
        repository: repository || getChatRepository(),
        retentionDays,
        maxChatsPerUser
      });
    } catch (error) {
      logger.error('Chat retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    } finally {
      sweeping = false;
    }
  };

  sweepTimer = setInterval(tick, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  tick();
  return stopChatRetentionSweep;
}

/**
 * Stop the daily sweep. A sweep already in flight runs to completion.
 *
 * @returns {void}
 */
export function stopChatRetentionSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
