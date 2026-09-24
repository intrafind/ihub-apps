/**
 * ChatShareRepository — share links for durable chats, on top of the storage
 * abstraction.
 *
 * Three documents per share:
 *
 *   `chat-shares/<shareId>`             the share: mode, recipients, limits, views
 *   `chat-share-messages/<shareId>`     the frozen transcript the link hands out
 *   `chat-share-recipients/<shareId>.<h>` one marker per recipient of a `users` share
 *
 * The share document is filed under the **chat id** as its document owner.
 * That is deliberate, and unlike the chat documents, which are filed under the
 * owning principal: every lookup except "open this link" is per chat — the
 * owner's list of a chat's shares, and the delete cascade that removes them
 * with the chat — and the document store's owner index is the one index it
 * has. The owning principal is a field inside the document.
 *
 * The recipient markers are filed under the recipient's user id for the same
 * reason: "shared with me" has to be an index read, not a scan of every share
 * in the installation.
 *
 * **A share is a snapshot.** A chat goes on after it was shared, and editing an
 * earlier message rewrites the stored transcript from that point. The owner
 * must know exactly what they handed out, so the messages are copied at share
 * time and the link never shows anything newer. Artifacts are *not* copied:
 * the artifact store is write-once and keyed per chat, so the snapshot only
 * records which artifact ids its messages carry, and the route serves those
 * ids out of the chat's own scope and nothing else. The chat repository, in
 * turn, asks {@link ChatShareRepository#artifactIdsRetainedByShares} before
 * it deletes the artifacts of messages an edit or the message cap removed, so
 * a picture an active share still shows survives the edit that dropped it
 * from the live chat.
 *
 * The share id is the URL. It is minted here from `crypto.randomBytes` and is
 * never the chat id, which is client-minted and enumerable.
 *
 * Every read-modify-write (a view, a revoke) runs under
 * `locks.withLock('chat-share:<id>')`, and the same no-op-when-unavailable
 * rule applies as in `ChatRepository`.
 *
 * @module services/chat/ChatShareRepository
 */
import { createHash, randomBytes } from 'crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { SHARE_MODES, shareState } from './chatSharing.js';

const COMPONENT = 'ChatShareRepository';

/** Namespace holding the share documents. */
export const CHAT_SHARES_NAMESPACE = RUNTIME_NAMESPACES.chatShares;

/** Namespace holding the frozen transcripts. */
export const CHAT_SHARE_MESSAGES_NAMESPACE = RUNTIME_NAMESPACES.chatShareMessages;

/** Namespace holding the per-recipient markers. */
export const CHAT_SHARE_RECIPIENTS_NAMESPACE = RUNTIME_NAMESPACES.chatShareRecipients;

/** Schema version stamped on a share document and its snapshot. */
export const CHAT_SHARE_VERSION = 1;

/**
 * Random bytes in a share id: 24 bytes is 192 bits, well past the 128 the
 * link needs to be unguessable, and 32 URL-safe characters once encoded.
 */
export const SHARE_ID_BYTES = 24;

/** Prefix on every share id, so one is recognizable in a log line. */
export const SHARE_ID_PREFIX = 'shr_';

/**
 * View entries kept on a share. The count is unbounded; the per-view log is
 * not, because a public link can be opened any number of times and the
 * document is re-read and re-written on every one of them. The newest entries
 * are kept.
 */
export const MAX_VIEW_ENTRIES = 200;

/** Documents per `list` call while walking a namespace. */
const SCAN_PAGE_SIZE = 200;

/** Hard bound on shares walked for an admin listing or the stats. */
const MAX_SCANNED_SHARES = 5000;

/** Lock lease for one share write — the same shape `ChatRepository` uses. */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

/** Fields of a stored message that a share never carries. */
const MESSAGE_FIELDS_DROPPED = new Set(['clientMessageId']);

/**
 * Mint a share id.
 *
 * @returns {string}
 */
export function mintShareId() {
  return `${SHARE_ID_PREFIX}${randomBytes(SHARE_ID_BYTES).toString('base64url')}`;
}

/**
 * Whether a string can be a share id: storable as a key and shaped like one
 * this module mints. Checked before any lookup so an arbitrary path segment
 * never reaches the store.
 *
 * @param {unknown} shareId - Candidate.
 * @returns {boolean}
 */
export function isShareId(shareId) {
  return (
    typeof shareId === 'string' &&
    shareId.startsWith(SHARE_ID_PREFIX) &&
    shareId.length > SHARE_ID_PREFIX.length &&
    isValidId(shareId)
  );
}

/**
 * The key of one recipient's marker: the share id plus a digest of the
 * recipient id. Digested because user ids are external strings (e-mail
 * addresses, OIDC subjects) that are not key-safe; the raw id is in the
 * marker's document owner and in its data.
 *
 * @param {string} shareId - Share id.
 * @param {string} recipientId - Recipient user id.
 * @returns {string}
 */
export function recipientMarkerKey(shareId, recipientId) {
  const digest = createHash('sha256').update(String(recipientId)).digest('hex').slice(0, 16);
  return `${shareId}.${digest}`;
}

/**
 * The snapshot form of one stored message: what was stored, minus the fields
 * that only mean something to the chat it came from.
 *
 * @param {Object} message - Stored message.
 * @returns {Object}
 */
export function snapshotMessage(message) {
  const copy = {};
  for (const [key, value] of Object.entries(message || {})) {
    if (MESSAGE_FIELDS_DROPPED.has(key)) continue;
    copy[key] = value;
  }
  return copy;
}

/**
 * Artifact ids named by a list of messages, without duplicates.
 *
 * @param {Object[]} messages - Stored or snapshot messages.
 * @returns {string[]}
 */
export function artifactIdsOf(messages) {
  const ids = new Set();
  for (const message of messages || []) {
    for (const artifact of Array.isArray(message?.artifacts) ? message.artifacts : []) {
      if (typeof artifact?.id === 'string' && artifact.id) ids.add(artifact.id);
    }
  }
  return [...ids];
}

/**
 * Newest first, by creation time.
 *
 * @param {Object} a - Share.
 * @param {Object} b - Share.
 * @returns {number}
 */
function compareSharesDesc(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

function toShare(doc) {
  return doc?.data ? doc.data : null;
}

/**
 * Durable share storage.
 */
export class ChatShareRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null makes every method a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet; null makes every method a no-op.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   * @param {() => string} [options.mintId] - Id minter, for tests.
   */
  constructor({ documents = null, locks = null, logger: log, mintId = mintShareId } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.logger = log || logger;
    this._mintId = mintId;
  }

  /**
   * Whether this repository can actually store anything.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  _withShareLock(shareId, fn) {
    return this.locks.withLock(`chat-share:${shareId}`, fn, LOCK_OPTIONS);
  }

  async _loadShare(shareId) {
    const doc = await this.documents.get(CHAT_SHARES_NAMESPACE, shareId);
    return { share: toShare(doc), etag: doc ? doc.etag : null };
  }

  async _writeShare(share, etag) {
    if (etag === undefined) {
      throw new StorageError('_writeShare needs the etag the matching read returned', {
        code: 'INVALID_ARGUMENT'
      });
    }
    const doc = await this.documents.put(CHAT_SHARES_NAMESPACE, share.id, share, {
      ownerId: share.chatId,
      etag
    });
    return toShare(doc);
  }

  /**
   * Create a share of `messages` for `chatId`.
   *
   * Written snapshot first, recipient markers second, share document last:
   * the share document is the only thing a link resolves through, so a
   * failure between the writes leaves an unreachable snapshot to sweep rather
   * than a link that opens onto nothing.
   *
   * @param {Object} options
   * @param {string} options.chatId - Chat being shared.
   * @param {string} options.ownerId - Principal that owns the chat, in `identityMode`.
   * @param {string} options.identityMode - Identity mode `ownerId` was resolved in.
   * @param {string|null} [options.appId] - App the chat belongs to.
   * @param {string} options.mode - One of {@link SHARE_MODES}.
   * @param {string[]} [options.recipients] - Recipient user ids (`users` mode).
   * @param {Array<{id: string, name?: string, email?: string}>} [options.recipientDetails] -
   *   What the owner's list shows for each recipient, captured at share time.
   * @param {string} [options.title] - Chat title at share time.
   * @param {string|null} [options.ownerName] - Owner's display name at share time.
   * @param {boolean} [options.showOwnerName] - Whether a public viewer sees it.
   * @param {string|null} [options.expiresAt] - ISO instant, or null.
   * @param {number|null} [options.maxViews] - Positive integer, or null.
   * @param {Object[]} options.messages - The stored transcript to freeze.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The share, or null when it cannot be stored.
   */
  async createShare({
    chatId,
    ownerId,
    identityMode,
    appId = null,
    mode,
    recipients = [],
    recipientDetails = [],
    title = '',
    ownerName = null,
    showOwnerName = false,
    expiresAt = null,
    maxViews = null,
    messages = [],
    now = new Date().toISOString()
  } = {}) {
    if (!this.isAvailable() || !isValidId(chatId) || !ownerId) return null;
    if (!SHARE_MODES.includes(mode)) {
      throw new StorageError(`Unknown share mode: ${String(mode).slice(0, 32)}`, {
        code: 'INVALID_ARGUMENT'
      });
    }
    const snapshot = (Array.isArray(messages) ? messages : []).map(snapshotMessage);
    const recipientIds =
      mode === 'users' ? [...new Set(recipients.map(id => String(id)).filter(Boolean))] : [];

    // A fresh id is free by construction; the create-only write below is the
    // guard against the astronomically unlikely collision.
    let id = this._mintId();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.documents.get(CHAT_SHARES_NAMESPACE, id))) break;
      id = this._mintId();
    }

    await this.documents.put(
      CHAT_SHARE_MESSAGES_NAMESPACE,
      id,
      { version: CHAT_SHARE_VERSION, shareId: id, chatId, messages: snapshot },
      { ownerId: chatId }
    );
    for (const recipientId of recipientIds) {
      await this.documents.put(
        CHAT_SHARE_RECIPIENTS_NAMESPACE,
        recipientMarkerKey(id, recipientId),
        { shareId: id, chatId, recipientId, createdAt: now },
        { ownerId: recipientId }
      );
    }
    const share = {
      version: CHAT_SHARE_VERSION,
      id,
      chatId,
      ownerId: String(ownerId),
      identityMode: identityMode || 'default',
      appId: appId || null,
      mode,
      recipients: recipientIds,
      recipientDetails: recipientIds.map(recipientId => {
        const detail = recipientDetails.find(entry => String(entry?.id) === recipientId) || {};
        return {
          id: recipientId,
          ...(detail.name ? { name: String(detail.name) } : {}),
          ...(detail.email ? { email: String(detail.email) } : {})
        };
      }),
      title: typeof title === 'string' ? title : '',
      ownerName: ownerName ? String(ownerName) : null,
      showOwnerName: showOwnerName === true,
      createdAt: now,
      expiresAt: expiresAt || null,
      maxViews: Number.isInteger(maxViews) && maxViews > 0 ? maxViews : null,
      viewCount: 0,
      lastViewedAt: null,
      views: [],
      recipientViews: {},
      revokedAt: null,
      messageCount: snapshot.length,
      artifactIds: artifactIdsOf(snapshot)
    };
    return this._writeShare(share, null);
  }

  /**
   * One share by id.
   *
   * @param {string} shareId - Share id.
   * @returns {Promise<Object|null>}
   */
  async getShare(shareId) {
    if (!this.isAvailable() || !isShareId(shareId)) return null;
    return (await this._loadShare(shareId)).share;
  }

  /**
   * The frozen transcript of one share.
   *
   * @param {string} shareId - Share id.
   * @returns {Promise<{version: number, messages: Object[]}|null>}
   */
  async getSnapshot(shareId) {
    if (!this.isAvailable() || !isShareId(shareId)) return null;
    const doc = await this.documents.get(CHAT_SHARE_MESSAGES_NAMESPACE, shareId);
    if (!doc?.data) return null;
    return {
      version: Number(doc.data.version) || CHAT_SHARE_VERSION,
      messages: Array.isArray(doc.data.messages) ? doc.data.messages : []
    };
  }

  /**
   * Every share of one chat, newest first — active and dead alike, because
   * the owner's list shows why a link stopped working.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<Object[]>}
   */
  async listSharesForChat(chatId) {
    if (!this.isAvailable() || !isValidId(chatId)) return [];
    const shares = [];
    let cursor = null;
    do {
      const page = await this.documents.list(CHAT_SHARES_NAMESPACE, {
        ownerId: chatId,
        limit: SCAN_PAGE_SIZE,
        includeData: true,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        const share = toShare(doc);
        if (share) shares.push(share);
      }
      cursor = page.nextCursor;
    } while (cursor && shares.length < MAX_SCANNED_SHARES);
    return shares.sort(compareSharesDesc);
  }

  /**
   * The `users` shares addressed to one user, newest first. Dead shares are
   * filtered out: a recipient has no business seeing a link that no longer
   * opens.
   *
   * @param {string} userId - Recipient user id.
   * @param {Object} [options]
   * @param {number} [options.now] - Clock, for tests.
   * @returns {Promise<Object[]>}
   */
  async listSharesForRecipient(userId, { now = Date.now() } = {}) {
    if (!this.isAvailable() || !userId) return [];
    const shareIds = new Set();
    let cursor = null;
    do {
      const page = await this.documents.list(CHAT_SHARE_RECIPIENTS_NAMESPACE, {
        ownerId: String(userId),
        limit: SCAN_PAGE_SIZE,
        includeData: true,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        if (typeof doc?.data?.shareId === 'string') shareIds.add(doc.data.shareId);
      }
      cursor = page.nextCursor;
    } while (cursor && shareIds.size < MAX_SCANNED_SHARES);
    const shares = [];
    for (const shareId of shareIds) {
      const share = await this.getShare(shareId);
      if (
        share &&
        shareState(share, now) === 'active' &&
        share.recipients?.includes(String(userId))
      ) {
        shares.push(share);
      }
    }
    return shares.sort(compareSharesDesc);
  }

  /**
   * Artifact ids that an active share of this chat still hands out.
   *
   * Asked by `ChatRepository.appendMessage` on the rare write that drops
   * messages from the transcript — an edit, a regenerate, the message cap —
   * so the payloads a link already handed out are not deleted from under it.
   * An index read over the chat's own shares, nothing more.
   *
   * @param {string} chatId - Chat id.
   * @param {Object} [options]
   * @param {number} [options.now] - Clock, for tests.
   * @returns {Promise<Set<string>>}
   */
  async artifactIdsRetainedByShares(chatId, { now = Date.now() } = {}) {
    const retained = new Set();
    if (!this.isAvailable() || !isValidId(chatId)) return retained;
    for (const share of await this.listSharesForChat(chatId)) {
      if (shareState(share, now) !== 'active') continue;
      for (const id of Array.isArray(share.artifactIds) ? share.artifactIds : []) retained.add(id);
    }
    return retained;
  }

  /**
   * Walk the whole namespace — for the admin page only. Bounded, and the
   * bound is reported so the page can say the list is cut.
   *
   * @param {Object} [options]
   * @param {number} [options.max] - Most shares to load.
   * @returns {Promise<{shares: Object[], truncated: boolean}>}
   */
  async scanShares({ max = MAX_SCANNED_SHARES } = {}) {
    if (!this.isAvailable()) return { shares: [], truncated: false };
    const shares = [];
    let cursor = null;
    let truncated = false;
    do {
      const page = await this.documents.list(CHAT_SHARES_NAMESPACE, {
        limit: SCAN_PAGE_SIZE,
        includeData: true,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        const share = toShare(doc);
        if (share) shares.push(share);
      }
      cursor = page.nextCursor;
      if (cursor && shares.length >= max) truncated = true;
    } while (cursor && !truncated);
    return { shares: shares.sort(compareSharesDesc), truncated };
  }

  /**
   * Counts for the admin overview: how many shares exist, in which state and
   * of which mode, and how often links were opened.
   *
   * @param {Object} [options]
   * @param {number} [options.now] - Clock, for tests.
   * @returns {Promise<Object>}
   */
  async collectStats({ now = Date.now() } = {}) {
    const { shares, truncated } = await this.scanShares();
    const stats = {
      total: shares.length,
      truncated,
      byState: { active: 0, revoked: 0, expired: 0, exhausted: 0 },
      byMode: { users: 0, authenticated: 0, public: 0 },
      activeByMode: { users: 0, authenticated: 0, public: 0 },
      views: 0
    };
    for (const share of shares) {
      const state = shareState(share, now);
      if (state in stats.byState) stats.byState[state] += 1;
      if (share.mode in stats.byMode) stats.byMode[share.mode] += 1;
      if (state === 'active' && share.mode in stats.activeByMode) {
        stats.activeByMode[share.mode] += 1;
      }
      stats.views += Number(share.viewCount) || 0;
    }
    return stats;
  }

  /**
   * Revoke a share. Idempotent: a second revoke returns the share unchanged.
   *
   * @param {string} shareId - Share id.
   * @param {Object} [options]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The share, or null when there is none.
   */
  async revokeShare(shareId, { now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isShareId(shareId)) return null;
    return this._withShareLock(shareId, async () => {
      const { share, etag } = await this._loadShare(shareId);
      if (!share) return null;
      if (share.revokedAt) return share;
      return this._writeShare({ ...share, revokedAt: now }, etag);
    });
  }

  /**
   * Count one open of a share, under its lock.
   *
   * The active check is repeated inside the lock: two viewers opening a link
   * with one view left would otherwise both be let in, and the second would
   * push the count past the limit the owner set. The open that reaches the
   * limit is the last one served.
   *
   * @param {string} shareId - Share id.
   * @param {string|null} viewerId - Signed-in viewer, or null. Matched against
   *   the recipients of a `users` share, which are raw user ids by design.
   * @param {Object} [options]
   * @param {number} [options.now] - Clock, for tests.
   * @param {string|null} [options.recordAs] - What the per-view log stores
   *   for this viewer: the principal id in the share's identity mode, so a
   *   pseudonymized installation never keeps raw viewer ids on a share.
   *   Defaults to `viewerId`.
   * @returns {Promise<{share: Object|null, counted: boolean}>}
   */
  async recordView(shareId, viewerId, { now = Date.now(), recordAs = viewerId } = {}) {
    if (!this.isAvailable() || !isShareId(shareId)) return { share: null, counted: false };
    return this._withShareLock(shareId, async () => {
      const { share, etag } = await this._loadShare(shareId);
      if (!share) return { share: null, counted: false };
      if (shareState(share, now) !== 'active') return { share, counted: false };
      const at = new Date(now).toISOString();
      const views = [
        ...(Array.isArray(share.views) ? share.views : []),
        { at, userId: recordAs ?? null }
      ];
      const recipientViews = { ...(share.recipientViews || {}) };
      if (viewerId && share.mode === 'users' && share.recipients?.includes(viewerId)) {
        const previous = recipientViews[viewerId] || { count: 0, lastViewedAt: null };
        recipientViews[viewerId] = { count: (Number(previous.count) || 0) + 1, lastViewedAt: at };
      }
      const next = await this._writeShare(
        {
          ...share,
          viewCount: (Number(share.viewCount) || 0) + 1,
          lastViewedAt: at,
          views: views.slice(-MAX_VIEW_ENTRIES),
          recipientViews
        },
        etag
      );
      return { share: next, counted: true };
    });
  }

  /**
   * Remove one share, its snapshot and its recipient markers.
   *
   * Share document first — the only thing a link resolves through — so a
   * failure part-way leaves an unreachable snapshot rather than a link that
   * opens onto nothing.
   *
   * @param {Object} share - Share document.
   * @returns {Promise<boolean>} Whether the share document existed.
   */
  async _deleteShare(share) {
    const removed = await this.documents.delete(CHAT_SHARES_NAMESPACE, share.id);
    await this.documents.delete(CHAT_SHARE_MESSAGES_NAMESPACE, share.id);
    for (const recipientId of Array.isArray(share.recipients) ? share.recipients : []) {
      await this.documents.delete(
        CHAT_SHARE_RECIPIENTS_NAMESPACE,
        recipientMarkerKey(share.id, recipientId)
      );
    }
    return removed;
  }

  /**
   * Remove every share of a chat — the cascade `deleteChatWithCascade` runs
   * when the chat itself goes.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<{removed: number}>}
   */
  async deleteSharesForChat(chatId) {
    if (!this.isAvailable() || !isValidId(chatId)) return { removed: 0 };
    const shares = await this.listSharesForChat(chatId);
    let removed = 0;
    for (const share of shares) {
      try {
        if (await this._deleteShare(share)) removed += 1;
      } catch (error) {
        this.logger.error('Failed to remove a share with its chat', {
          component: COMPONENT,
          chatId,
          shareId: share.id,
          error: error.message
        });
      }
    }
    return { removed };
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the bootstrapped storage provider.
 *
 * @returns {ChatShareRepository}
 */
export function getChatShareRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ChatShareRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default ChatShareRepository;
