/**
 * ChatRepository — durable chats on top of the storage abstraction.
 *
 * Two documents per chat, both owned by the run principal:
 *
 *   `chats/<chatId>`          the metadata a chat list needs, small and hot
 *   `chat-messages/<chatId>`  the transcript, read in one go when a chat opens
 *
 * They are split because the list view reads N chat documents and zero
 * transcripts; folding the messages in would make "show my chats" read every
 * message the user ever wrote.
 *
 * Everything here degrades to a no-op when storage is unavailable — a
 * misconfigured provider must leave chats working exactly as they did before
 * persistence existed, not fail requests. The same is true for a chat id the
 * store cannot key (headless agent chats are `agent:<runId>:<hex>`, and a
 * colon is not a valid document key): such a chat is legal, it simply has no
 * durable form.
 *
 * Every read-modify-write runs under `locks.withLock('chat:<id>')`. Two
 * browser tabs on one chat are ordinary here, and an unlocked
 * read-append-write would silently drop one tab's message. A
 * {@link LockTimeoutError} therefore propagates to the caller: writing anyway
 * is precisely the corruption the lock exists to prevent.
 *
 * @module services/chat/ChatRepository
 */
import { randomUUID } from 'crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { chatMessageCap } from './chatPersistence.js';

const COMPONENT = 'ChatRepository';

/** Namespace holding the chat metadata documents. */
export const CHATS_NAMESPACE = RUNTIME_NAMESPACES.chats;

/** Namespace holding the chat transcript documents. */
export const CHAT_MESSAGES_NAMESPACE = RUNTIME_NAMESPACES.chatMessages;

/** Schema version stamped on a transcript document. */
export const CHAT_MESSAGES_VERSION = 1;

/** Lifecycle states a chat document may carry. */
export const CHAT_STATUSES = ['active', 'running', 'error'];

/** Longest title derived from a user message. */
export const MAX_DERIVED_TITLE_LENGTH = 80;

/** Longest title accepted from a rename. */
export const MAX_TITLE_LENGTH = 200;

/**
 * Run ids kept on a chat for the delete cascade. There is no chatId→runId
 * index anywhere else in the tree, so this list is how `DELETE /api/chats/:id`
 * finds the ledger runs to remove with it. Capped because a long-lived chat
 * would otherwise grow the document without bound; the oldest runs age out of
 * the ledger's own retention anyway.
 */
export const MAX_TRACKED_RUN_IDS = 200;

/** Page size of {@link ChatRepository#listChats} when the caller names none. */
const DEFAULT_PAGE_SIZE = 30;

/** Largest page {@link ChatRepository#listChats} will return. */
const MAX_PAGE_SIZE = 100;

/** Page size used while walking an owner's chats out of the store. */
const OWNER_PAGE_SIZE = 200;

/**
 * How long one owner's loaded chat set is reused, in milliseconds.
 *
 * `listChats` has no stored order by `lastMessageAt`, so it loads the owner's
 * chat documents and sorts them in memory — and its cursor is a position in
 * that sort, not a store cursor, so every page repeated the whole load. Page
 * seven of a 200-chat owner cost 1400 document reads, and the sidebar
 * invalidates its list after every completed turn.
 *
 * Short on purpose. The window only has to cover a burst — a page, the "show
 * older" that follows it, the refetch after a turn — and a stale listing is a
 * chat missing from the top of somebody's sidebar for a moment.
 */
const OWNER_CHATS_TTL_MS = 5000;

/**
 * Hard bound on how many of one owner's chats are loaded for the in-memory
 * sort. `platform.chats.maxChatsPerUser` (default 200) keeps the real number
 * well under this; the cap only decides what happens when retention is off and
 * a user has accumulated thousands. Then the first 1000 chats in ascending key
 * order are loaded and the rest are invisible to the list. Chat ids are random
 * uuids, so that slice has no relation to recency in either direction — see
 * the honesty note on {@link ChatRepository#listChats}.
 */
const MAX_OWNER_CHATS = 1000;

/**
 * Lock lease for one chat write. Short: the critical section is two document
 * writes, and a lease held longer than that means a dead worker whose lock we
 * want taken over quickly.
 */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

/** Fields a patch may never change — identity and the owner index depend on them. */
const PROTECTED_CHAT_FIELDS = new Set([
  'id',
  'ownerId',
  'identityMode',
  'createdAt',
  '__proto__',
  'constructor',
  'prototype'
]);

/** Optional per-message fields carried through to storage when supplied. */
const OPTIONAL_MESSAGE_FIELDS = [
  'clientMessageId',
  'usage',
  'error',
  'finishReason',
  'attachments'
];

/**
 * Whether a chat id can be a storage key.
 *
 * Chat ids are client-minted and unconstrained today, and some are structural
 * rather than storable (`agent:<parentRunId>:<hex>` for headless invocations).
 * Callers use this to skip the persistence path early instead of catching an
 * `InvalidKeyError` per turn.
 *
 * @param {unknown} chatId - Candidate chat id.
 * @returns {boolean}
 */
export function isPersistableChatId(chatId) {
  return isValidId(chatId);
}

/**
 * Derive a chat title from a message: whitespace collapsed, trimmed, and cut
 * to `maxLength` with an ellipsis so a pasted wall of text does not become the
 * sidebar entry.
 *
 * @param {unknown} content - Message content.
 * @param {number} [maxLength=MAX_DERIVED_TITLE_LENGTH] - Inclusive length cap.
 * @returns {string} The title, or '' when nothing usable was given.
 */
export function deriveChatTitle(content, maxLength = MAX_DERIVED_TITLE_LENGTH) {
  if (typeof content !== 'string') return '';
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Normalize a title supplied by a caller (creation or rename).
 *
 * @param {unknown} title - Candidate title.
 * @param {number} [maxLength=MAX_TITLE_LENGTH] - Inclusive length cap.
 * @returns {string}
 */
function normalizeTitle(title, maxLength = MAX_TITLE_LENGTH) {
  return deriveChatTitle(title, maxLength);
}

/**
 * Coerce a stored `runIds` value into a capped array of ids.
 *
 * @param {unknown} runIds - Stored value.
 * @returns {string[]}
 */
function normalizeRunIds(runIds) {
  if (!Array.isArray(runIds)) return [];
  const unique = [];
  for (const runId of runIds) {
    if (typeof runId === 'string' && runId && !unique.includes(runId)) unique.push(runId);
  }
  return unique.length > MAX_TRACKED_RUN_IDS ? unique.slice(-MAX_TRACKED_RUN_IDS) : unique;
}

/**
 * Add a run id to a chat's cascade list, keeping the most recent ones.
 *
 * @param {string[]} runIds - Current list.
 * @param {string} runId - Run to track.
 * @returns {string[]} A new list.
 */
function trackRunId(runIds, runId) {
  if (runIds.includes(runId)) return runIds;
  const next = [...runIds, runId];
  return next.length > MAX_TRACKED_RUN_IDS ? next.slice(-MAX_TRACKED_RUN_IDS) : next;
}

/**
 * Build the chat object callers see from a stored document.
 *
 * @param {Object|null} doc - Document from the store.
 * @returns {Object|null} The chat, or null when there was no document.
 */
function toChat(doc) {
  if (!doc || !doc.data || typeof doc.data !== 'object') return null;
  return {
    ...doc.data,
    id: doc.key,
    ownerId: doc.data.ownerId ?? doc.ownerId ?? null,
    runIds: normalizeRunIds(doc.data.runIds)
  };
}

/**
 * The chat-scoped answering settings a turn records, so reopening the chat
 * restores the way it was being answered.
 *
 * The list is closed on purpose. These values come from a request body and
 * are written to a document that is read back for as long as the chat lives,
 * so an open-ended blob would let a client store whatever it liked under a
 * key the server never looks at. Anything absent from a turn is simply not
 * recorded by it — a turn that did not send `websearchEnabled` leaves
 * whatever the last one said, which is what "the chat remembers" means.
 *
 * `modelId` is not here: it has its own field on the chat document and is
 * written by the materializer.
 *
 * @type {Readonly<Object<string, 'string'|'number'|'boolean'|'stringArray'>>}
 */
const CHAT_SETTING_TYPES = Object.freeze({
  style: 'string',
  outputFormat: 'string',
  temperature: 'number',
  sendChatHistory: 'boolean',
  thinkingEnabled: 'boolean',
  thinkingBudget: 'number',
  thinkingThoughts: 'boolean',
  enabledTools: 'stringArray',
  websearchEnabled: 'boolean',
  imageAspectRatio: 'string',
  imageQuality: 'string'
});

/** Longest string a single setting may be, and the cap on `enabledTools`. */
const MAX_SETTING_CHARS = 64;

/**
 * Longest message body a chat stores.
 *
 * The two user-controlled quantities on this path — how long a message is and
 * how many there are — were the only ones with no bound, while every field
 * beside them has one. The count is capped by `chats.maxMessagesPerChat`; this
 * is the other half.
 *
 * What it costs without one: a transcript is a single document, so every later
 * turn reads, re-serializes and re-hashes the whole of it under the chat's
 * lock, and opening the chat ships all of it back. One 40 MB message —
 * accepted, because the global body limit is megabytes — makes every
 * subsequent turn on that chat pay for it, for as long as the chat exists.
 * Retention is age and chat count, so nothing reclaims it, and prompt replay
 * does not rescue it either: `microcompactMessages` deliberately skips user
 * messages.
 *
 * 100k characters is roughly 25k tokens — past what a turn could usefully
 * send, and far past anything a person types.
 */
export const MAX_MESSAGE_CHARS = 100_000;
const MAX_ENABLED_TOOLS = 64;

/**
 * The storable subset of a turn's settings.
 *
 * Returns null when nothing survives, so a caller can tell "this turn said
 * nothing about settings" from "this turn asked for the defaults" — the first
 * must leave the stored ones alone.
 *
 * @param {unknown} settings - Candidate settings, as a request sent them.
 * @returns {Object|null} The subset worth storing, or null.
 */
export function normalizeChatSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const out = {};
  for (const [key, kind] of Object.entries(CHAT_SETTING_TYPES)) {
    if (!Object.hasOwn(settings, key)) continue;
    const value = settings[key];
    if (value === null || value === undefined) continue;
    if (kind === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (kind === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    } else if (kind === 'string') {
      if (typeof value === 'string' && value) out[key] = value.slice(0, MAX_SETTING_CHARS);
    } else if (kind === 'stringArray') {
      if (!Array.isArray(value)) continue;
      out[key] = value
        .filter(entry => typeof entry === 'string' && entry)
        .slice(0, MAX_ENABLED_TOOLS)
        .map(entry => entry.slice(0, MAX_SETTING_CHARS));
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Apply a patch to a chat, protecting the immutable fields and re-deriving
 * the values that are computed rather than set.
 *
 * @param {Object} chat - Stored chat.
 * @param {Object} patch - Fields to change.
 * @returns {Object} A new chat object.
 */
function applyChatPatch(chat, patch) {
  const next = { ...chat };
  for (const [key, value] of Object.entries(patch || {})) {
    if (PROTECTED_CHAT_FIELDS.has(key) || value === undefined) continue;
    next[key] = value;
  }
  if ('title' in patch) next.title = normalizeTitle(next.title);
  // Settings merge rather than replace: a turn that mentioned only the
  // websearch toggle must not erase the style the chat was started with.
  if ('settings' in patch) {
    const incoming = normalizeChatSettings(patch.settings);
    const existing = normalizeChatSettings(chat.settings);
    const merged = { ...(existing || {}), ...(incoming || {}) };
    next.settings = Object.keys(merged).length > 0 ? merged : null;
  } else {
    next.settings = normalizeChatSettings(chat.settings);
  }
  // An unknown status is dropped rather than stored: the chat list renders it.
  if (!CHAT_STATUSES.includes(next.status)) next.status = chat.status || 'active';
  if (!Number.isFinite(next.messageCount)) next.messageCount = chat.messageCount || 0;
  next.hasUnseenActivity = next.hasUnseenActivity === true;
  next.runIds = normalizeRunIds(next.runIds);
  // A run that was ever active on this chat is a run the delete cascade owes
  // the ledger, whether or not a message from it ever landed.
  if (typeof next.activeRunId === 'string' && next.activeRunId) {
    next.runIds = trackRunId(next.runIds, next.activeRunId);
  }
  return next;
}

/**
 * Normalize a stored transcript document.
 *
 * @param {unknown} data - Stored document body.
 * @returns {{version: number, messages: Object[]}}
 */
function toMessages(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const version = Number.isFinite(data?.version) ? data.version : CHAT_MESSAGES_VERSION;
  return { version, messages };
}

/**
 * Build the stored form of a message.
 *
 * The id is server-minted so the client can adopt a stable identity on
 * hydrate; the client's own exchange id is kept as `clientMessageId` so an
 * optimistic render can be reconciled instead of duplicated.
 *
 * @param {Object} message - Message as the materializer describes it.
 * @returns {Object} The message to store.
 */
function buildMessage(message = {}) {
  const content = typeof message.content === 'string' ? message.content : '';
  const stored = {
    id: typeof message.id === 'string' && message.id ? message.id : randomUUID(),
    role: typeof message.role === 'string' && message.role ? message.role : 'user',
    content: content.slice(0, MAX_MESSAGE_CHARS),
    ts: typeof message.ts === 'string' && message.ts ? message.ts : new Date().toISOString(),
    runId: typeof message.runId === 'string' && message.runId ? message.runId : null
  };
  // Said rather than done quietly: a reader that finds a message ending
  // mid-sentence should be able to tell that from one the model actually cut
  // short, and the original length is what makes the cap answerable to whoever
  // has to explain it.
  if (content.length > MAX_MESSAGE_CHARS) {
    stored.truncated = { at: MAX_MESSAGE_CHARS, originalLength: content.length };
  }
  // `messageId` is what the wire calls the client's exchange id; accept either
  // spelling so a caller holding the raw request field cannot lose it.
  const clientMessageId = message.clientMessageId ?? message.messageId;
  if (clientMessageId !== undefined && clientMessageId !== null) {
    stored.clientMessageId = String(clientMessageId);
  }
  for (const field of OPTIONAL_MESSAGE_FIELDS) {
    if (field === 'clientMessageId') continue;
    if (message[field] !== undefined && message[field] !== null) stored[field] = message[field];
  }
  return stored;
}

/**
 * Index of the last stored message belonging to a run, or -1 when it wrote
 * none.
 *
 * @param {Object[]} messages - Stored transcript.
 * @param {string} runId - Run to locate.
 * @returns {number}
 */
function lastIndexOfRun(messages, runId) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.runId === runId) return index;
  }
  return -1;
}

/**
 * Order chats newest-first, breaking ties on id so paging is deterministic.
 *
 * @param {{lastMessageAt?: string, id: string}} a
 * @param {{lastMessageAt?: string, id: string}} b
 * @returns {number}
 */
function compareChatsDesc(a, b) {
  const left = a.lastMessageAt || '';
  const right = b.lastMessageAt || '';
  if (left !== right) return left < right ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Encode the paging cursor. It carries the sort position rather than an
 * offset, so a chat that moves to the top between two pages cannot make the
 * next page repeat or skip an entry.
 *
 * @param {{lastMessageAt?: string, id: string}} chat - Last chat of the page.
 * @returns {string}
 */
function encodeCursor(chat) {
  const payload = JSON.stringify({ t: chat.lastMessageAt || '', i: chat.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode a paging cursor.
 *
 * @param {string} cursor - Cursor from a previous page.
 * @returns {{lastMessageAt: string, id: string}}
 * @throws {StorageError} Code `INVALID_CURSOR` for anything this store did not
 *   issue — never silently restarting the listing, which would make a paging
 *   loop repeat forever.
 */
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof parsed?.t === 'string' && typeof parsed?.i === 'string') {
      return { lastMessageAt: parsed.t, id: parsed.i };
    }
  } catch {
    // Fall through to the single error below: a malformed cursor and a
    // well-formed cursor carrying the wrong shape are the same mistake.
  }
  throw new StorageError('Invalid chat list cursor', { code: 'INVALID_CURSOR' });
}

/**
 * Clamp a requested page size instead of rejecting it.
 *
 * @param {unknown} limit - Requested size.
 * @returns {number}
 */
function clampPageSize(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

/**
 * Durable chat storage.
 */
export class ChatRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null makes every method a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet; null makes every method a no-op, because an unlocked
   *   read-modify-write is not a degraded mode, it is data loss.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   */
  constructor({ documents = null, locks = null, logger: log, maxMessages = null } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.logger = log || logger;
    /**
     * Messages one chat may keep, or null for "ask the platform config".
     * Resolved per write rather than captured here, so an admin who lowers it
     * does not have to restart the server for it to take effect.
     */
    this._maxMessages = maxMessages;
    /**
     * One owner's loaded chat set, held for {@link OWNER_CHATS_TTL_MS} so a
     * cursor walk does not repeat it. Keyed by owner; entries are dropped by
     * `_forgetOwnerChats` whenever this process changes what a listing shows.
     * @type {Map<string, {at: number, chats: Object[], pending?: Promise<Object[]>}>}
     */
    this._ownerChats = new Map();
  }

  /**
   * How many messages this chat may keep; `<= 0` means no cap.
   *
   * @returns {number}
   * @private
   */
  _messageCap() {
    if (this._maxMessages !== null) return this._maxMessages;
    return chatMessageCap();
  }

  /**
   * Whether this repository can actually store anything.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  /**
   * Whether an operation on this chat can reach storage at all.
   *
   * @param {string} chatId - Chat id.
   * @param {string} operation - Method name, for the log line.
   * @returns {boolean}
   * @private
   */
  _usable(chatId, operation) {
    if (!this.isAvailable()) return false;
    if (!isPersistableChatId(chatId)) {
      this.logger.debug?.('Chat id is not storable; skipping persistence', {
        component: COMPONENT,
        operation,
        chatId: String(chatId).slice(0, 64)
      });
      return false;
    }
    return true;
  }

  /**
   * Run `fn` while holding this chat's lock.
   *
   * The lock is never bypassed on timeout: a {@link LockTimeoutError} carries
   * `httpStatus` 503 and reaches the caller unchanged, because the alternative
   * — writing without it — loses one of two concurrent turns.
   *
   * @param {string} chatId - Chat id.
   * @param {() => Promise<T>} fn - Critical section.
   * @returns {Promise<T>}
   * @template T
   * @private
   */
  _withChatLock(chatId, fn) {
    return this.locks.withLock(`chat:${chatId}`, fn, LOCK_OPTIONS);
  }

  /**
   * Read a chat without taking the lock — for use inside one.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<Object|null>}
   * @private
   */
  async _readChat(chatId) {
    return toChat(await this.documents.get(CHATS_NAMESPACE, chatId));
  }

  /**
   * Write a chat without taking the lock — for use inside one.
   *
   * @param {Object} chat - Complete chat document.
   * @returns {Promise<Object>} The stored chat.
   * @private
   */
  async _writeChat(chat) {
    const doc = await this.documents.put(CHATS_NAMESPACE, chat.id, chat, {
      ownerId: chat.ownerId
    });
    // The single funnel for every change a listing can show — create, rename,
    // a turn moving the chat to the top, the unseen flag — so the memo is
    // dropped here rather than at each of them.
    this._forgetOwnerChats(chat.ownerId);
    return toChat(doc);
  }

  /**
   * Read a transcript without taking the lock — for use inside one.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<{version: number, messages: Object[]}>}
   * @private
   */
  async _readMessages(chatId) {
    const doc = await this.documents.get(CHAT_MESSAGES_NAMESPACE, chatId);
    return toMessages(doc?.data);
  }

  /**
   * Write a transcript without taking the lock — for use inside one.
   *
   * @param {string} chatId - Chat id.
   * @param {string|null} ownerId - Owner, mirrored from the chat document so
   *   the transcript is reachable by the same owner index.
   * @param {Object[]} messages - Complete message list.
   * @returns {Promise<{version: number, messages: Object[]}>}
   * @private
   */
  async _writeMessages(chatId, ownerId, messages) {
    const body = { version: CHAT_MESSAGES_VERSION, messages };
    await this.documents.put(CHAT_MESSAGES_NAMESPACE, chatId, body, { ownerId });
    return body;
  }

  /**
   * One chat's metadata.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<Object|null>} The chat, or null when it does not exist
   *   or storage is unavailable.
   */
  async getChat(chatId) {
    if (!this._usable(chatId, 'getChat')) return null;
    return this._readChat(chatId);
  }

  /**
   * Walk an owner's chats out of the store.
   *
   * @param {string} ownerId - Owning principal id.
   * @returns {Promise<Object[]>} Chats in store (key) order.
   * @private
   */
  async _loadOwnerChats(ownerId) {
    const cached = this._ownerChats.get(ownerId);
    if (cached && Date.now() - cached.at < OWNER_CHATS_TTL_MS) return cached.chats;
    if (cached?.pending) return cached.pending;

    const pending = this._scanOwnerChats(ownerId)
      .then(chats => {
        this._ownerChats.set(ownerId, { at: Date.now(), chats });
        return chats;
      })
      .catch(error => {
        this._ownerChats.delete(ownerId);
        throw error;
      });
    // Concurrent callers share one walk: the sidebar and the history page ask
    // within the same tick often enough to matter.
    this._ownerChats.set(ownerId, { at: 0, chats: cached?.chats ?? [], pending });
    return pending;
  }

  /**
   * Page an owner's chat documents out of the store, without the memo.
   *
   * @param {string} ownerId - Owning principal id.
   * @returns {Promise<Object[]>} The owner's chats, in key order.
   * @private
   */
  async _scanOwnerChats(ownerId) {
    const chats = [];
    let cursor = null;
    do {
      const page = await this.documents.list(CHATS_NAMESPACE, {
        ownerId,
        limit: OWNER_PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        const chat = toChat(doc);
        if (chat) chats.push(chat);
      }
      cursor = page.nextCursor;
    } while (cursor && chats.length < MAX_OWNER_CHATS);
    return chats;
  }

  /**
   * Forget an owner's memoized chat set, because this process just changed it.
   *
   * A write this process made must be visible to its own next read — the
   * client sends the turn and then reloads the list, and answering that from a
   * five-second-old snapshot would show them a chat they just renamed under
   * its old title, or one they just deleted. Only the writes that change what
   * a *listing* shows invalidate; a message append does, because it moves the
   * chat to the top.
   *
   * @param {string|null|undefined} ownerId - Owner whose listing changed.
   * @returns {void}
   * @private
   */
  _forgetOwnerChats(ownerId) {
    if (ownerId) this._ownerChats.delete(ownerId);
  }

  /**
   * One page of an owner's chats, newest activity first.
   *
   * **How this scales, honestly.** `DocumentStore.list` orders by key and only
   * the owner filter is index-backed, so there is no stored order by
   * `lastMessageAt`. This loads the owner's chat documents (an indexed
   * directory read plus one small read per chat), sorts them in memory and
   * then pages. `platform.chats.maxChatsPerUser` — 200 by default — is what
   * keeps that bounded, and {@link MAX_OWNER_CHATS} bounds it even when
   * retention is switched off. Past that bound only the first 1000 chats in
   * ascending key order are loaded, and since chat ids are random uuids that
   * slice is unrelated to recency: an owner over the bound has chats that this
   * listing simply cannot see, whatever their activity. A database-backed
   * provider will answer this with an index instead, and this method should
   * shrink to a query then.
   *
   * @param {string} ownerId - Owning principal id.
   * @param {Object} [options]
   * @param {number} [options.limit=30] - Page size, clamped to 100.
   * @param {string|null} [options.cursor=null] - Cursor from a previous page.
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   * @throws {StorageError} Code `INVALID_CURSOR` for a cursor this store did
   *   not issue.
   */
  async listChats(ownerId, { limit = DEFAULT_PAGE_SIZE, cursor = null } = {}) {
    if (!this.isAvailable() || !ownerId) return { items: [], nextCursor: null };
    const pageSize = clampPageSize(limit);
    const after = cursor ? decodeCursor(cursor) : null;

    const sorted = (await this._loadOwnerChats(ownerId)).sort(compareChatsDesc);
    const remaining = after ? sorted.filter(chat => compareChatsDesc(chat, after) > 0) : sorted;
    const items = remaining.slice(0, pageSize);
    const nextCursor =
      items.length > 0 && remaining.length > items.length
        ? encodeCursor(items[items.length - 1])
        : null;
    return { items, nextCursor };
  }

  /**
   * How many chats an owner has, bounded the same way {@link listChats} is.
   *
   * @param {string} ownerId - Owning principal id.
   * @returns {Promise<number>}
   */
  async countChats(ownerId) {
    if (!this.isAvailable() || !ownerId) return 0;
    let count = 0;
    let cursor = null;
    do {
      const page = await this.documents.list(CHATS_NAMESPACE, {
        ownerId,
        limit: OWNER_PAGE_SIZE,
        includeData: false,
        ...(cursor ? { cursor } : {})
      });
      count += page.items.length;
      cursor = page.nextCursor;
    } while (cursor && count < MAX_OWNER_CHATS);
    return count;
  }

  /**
   * Return this chat, creating it when it does not exist yet.
   *
   * An existing chat is returned untouched — including one owned by somebody
   * else. Ownership is decided by `chatAccess.authorizeChat` before the write
   * path runs; silently re-owning a chat here would turn a missing check into
   * data theft rather than a 404.
   *
   * @param {Object} options
   * @param {string} options.chatId - Chat id.
   * @param {string} options.ownerId - Run principal that owns the chat.
   * @param {string} options.identityMode - Identity mode `ownerId` was
   *   resolved in; stored so the owner still matches after an admin changes
   *   `platform.runLog.identityMode`.
   * @param {string} [options.appId] - App the chat belongs to.
   * @param {string} [options.modelId] - Model the chat last used.
   * @param {Object} [options.settings] - Answering settings of the opening turn.
   * @param {string} [options.title] - Initial title; the first user message
   *   supplies one when this is empty.
   * @returns {Promise<Object|null>} The chat, or null when it cannot be stored.
   */
  async ensureChat({ chatId, ownerId, identityMode, appId, modelId, settings, title } = {}) {
    if (!this._usable(chatId, 'ensureChat') || !ownerId) return null;
    return this._withChatLock(chatId, async () => {
      const existing = await this._readChat(chatId);
      if (existing) return existing;
      const now = new Date().toISOString();
      return this._writeChat({
        id: chatId,
        ownerId: String(ownerId),
        identityMode: identityMode || 'default',
        appId: appId || null,
        modelId: modelId || null,
        settings: normalizeChatSettings(settings),
        title: normalizeTitle(title),
        titleSetByUser: false,
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
        activeRunId: null,
        hasUnseenActivity: false,
        status: 'active',
        runIds: []
      });
    });
  }

  /**
   * Patch a chat's metadata under its lock.
   *
   * `id`, `ownerId`, `identityMode` and `createdAt` are immutable and ignored
   * in the patch. Setting `activeRunId` also records the run in `runIds`, so
   * the delete cascade knows about a run even if it never produced a message.
   *
   * @param {string} chatId - Chat id.
   * @param {Object} patch - Fields to change.
   * @returns {Promise<Object|null>} The stored chat, or null when it does not
   *   exist or cannot be stored.
   */
  async updateChat(chatId, patch = {}) {
    if (!this._usable(chatId, 'updateChat')) return null;
    return this._withChatLock(chatId, async () => {
      const existing = await this._readChat(chatId);
      if (!existing) return null;
      return this._writeChat(applyChatPatch(existing, patch));
    });
  }

  /**
   * Release a run's hold on a chat: apply `patch` only while `runId` is still
   * the chat's active run.
   *
   * Turns on one chat overlap by design — `ChatService.runTurn` supersedes an
   * in-flight turn rather than refusing the new one — so the superseded turn
   * finishes *after* its replacement has already claimed the chat. An
   * unconditional patch there would announce the chat idle (`status: 'active'`,
   * `activeRunId: null`) while the replacement is still generating, and would
   * overwrite its `hasUnseenActivity`. The compare happens inside the chat's
   * own lock, so the check and the write cannot straddle another writer.
   *
   * @param {string} chatId - Chat id.
   * @param {string} runId - Run releasing the chat.
   * @param {Object} [patch] - Fields to apply when the run still owns the chat.
   * @returns {Promise<{chat: Object|null, released: boolean}>} The chat as it
   *   stands (null when it does not exist or cannot be stored) and whether the
   *   patch was applied.
   */
  async releaseRun(chatId, runId, patch = {}) {
    if (!this._usable(chatId, 'releaseRun')) return { chat: null, released: false };
    return this._withChatLock(chatId, async () => {
      const existing = await this._readChat(chatId);
      if (!existing) return { chat: null, released: false };
      if (existing.activeRunId !== runId) return { chat: existing, released: false };
      return { chat: await this._writeChat(applyChatPatch(existing, patch)), released: true };
    });
  }

  /**
   * Give a chat a user-chosen title.
   *
   * The title is marked as user-set so no later turn derives over it. An empty
   * title clears that mark instead, which lets the next user message derive a
   * fresh one — a rename to nothing is a reset, not a permanently blank chat.
   *
   * @param {string} chatId - Chat id.
   * @param {string} title - New title, capped at 200 characters.
   * @returns {Promise<Object|null>} The stored chat, or null when it does not
   *   exist or cannot be stored.
   */
  async renameChat(chatId, title) {
    if (!this._usable(chatId, 'renameChat')) return null;
    return this._withChatLock(chatId, async () => {
      const existing = await this._readChat(chatId);
      if (!existing) return null;
      const normalized = normalizeTitle(title);
      return this._writeChat({
        ...existing,
        title: normalized,
        titleSetByUser: normalized.length > 0
      });
    });
  }

  /**
   * Remove a chat and its transcript.
   *
   * The ledger runs are returned rather than deleted: cascading into `RunLog`
   * is the route's job, because it is the layer that knows the ledger exists.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<{deleted: boolean, runIds: string[]}>}
   */
  async deleteChat(chatId) {
    if (!this._usable(chatId, 'deleteChat')) return { deleted: false, runIds: [] };
    return this._withChatLock(chatId, async () => {
      const existing = await this._readChat(chatId);
      const runIds = normalizeRunIds(existing?.runIds);
      // Unwind in reverse of the write order: the transcript first, the chat
      // document — the only thing that can reach it — last. These are two
      // non-transactional writes, and with the index removed first a failure
      // between them stranded the full verbatim transcript with nothing
      // pointing at it: `chat-messages` is never enumerated anywhere, so
      // neither the list, the retention sweep nor a retried delete could find
      // it again, while the user had been told the chat was erased. This way
      // a partial delete leaves a listable, re-deletable chat with an empty
      // transcript. Same rule `put` states — invisible data is worse than a
      // dangling index entry.
      const removedMessages = await this.documents.delete(CHAT_MESSAGES_NAMESPACE, chatId);
      const removedChat = await this.documents.delete(CHATS_NAMESPACE, chatId);
      // A delete is the other thing that changes a listing, and it does not go
      // through `_writeChat`.
      this._forgetOwnerChats(existing?.ownerId);
      return { deleted: removedChat || removedMessages, runIds };
    });
  }

  /**
   * A chat's stored transcript.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<{version: number, messages: Object[]}>} An empty
   *   transcript when the chat has none or storage is unavailable.
   */
  async getMessages(chatId) {
    if (!this._usable(chatId, 'getMessages')) {
      return { version: CHAT_MESSAGES_VERSION, messages: [] };
    }
    return this._readMessages(chatId);
  }

  /**
   * Append a message to a chat, optionally forking the history first.
   *
   * With `replaceFromMessageId` the stored history is truncated from that
   * message (inclusive) before the append — the server-side form of "edit this
   * message and regenerate". An id that is not in the history is an error, not
   * a plain append: appending the regenerated turn onto the full history would
   * duplicate everything the user meant to replace.
   *
   * The chat document's `lastMessageAt`, `messageCount`, `runIds` and derived
   * title are updated inside the same lock, so a reader never sees a
   * transcript and a metadata document that disagree.
   *
   * `insertAfterRunId` places the message directly after the last stored
   * message of that run instead of at the very end. For the ordinary turn
   * those are the same position; they differ only when a superseded turn
   * finishes after its replacement already wrote a user message, and there
   * appending would interleave the two exchanges permanently — the transcript
   * is what later turns replay to the model.
   *
   * @param {string} chatId - Chat id.
   * @param {Object} message - Message to store; see {@link buildMessage}.
   * @param {Object} [options]
   * @param {string|null} [options.replaceFromMessageId=null] - Stored message
   *   id to truncate from, inclusive.
   * @param {string|null} [options.insertAfterRunId=null] - Place the message
   *   after the last message of this run; appends when the run has none.
   * @returns {Promise<{message: Object, messages: Object[]}|null>} Null when
   *   the chat does not exist or cannot be stored.
   * @throws {StorageError} Code `UNKNOWN_MESSAGE` when `replaceFromMessageId`
   *   is not in the stored history.
   */
  async appendMessage(
    chatId,
    message,
    { replaceFromMessageId = null, insertAfterRunId = null } = {}
  ) {
    if (!this._usable(chatId, 'appendMessage')) return null;
    return this._withChatLock(chatId, async () => {
      const chat = await this._readChat(chatId);
      if (!chat) {
        this.logger.warn('Cannot append to a chat that was never created', {
          component: COMPONENT,
          chatId
        });
        return null;
      }

      const stored = await this._readMessages(chatId);
      let messages = stored.messages;
      if (replaceFromMessageId) {
        const index = messages.findIndex(entry => entry.id === replaceFromMessageId);
        if (index === -1) {
          throw new StorageError(`Message ${replaceFromMessageId} is not part of chat ${chatId}`, {
            code: 'UNKNOWN_MESSAGE'
          });
        }
        messages = messages.slice(0, index);
      }

      const entry = buildMessage(message);
      const at = insertAfterRunId ? lastIndexOfRun(messages, insertAfterRunId) : -1;
      messages =
        at === -1
          ? [...messages, entry]
          : [...messages.slice(0, at + 1), entry, ...messages.slice(at + 1)];

      // Oldest first, after the insert rather than before it, so the message
      // being written is never the one dropped.
      //
      // A transcript is one document: every append rewrites, re-serializes and
      // re-hashes the whole thing, and opening the chat ships all of it back.
      // Prompt replay usually makes a chat unusable long before that becomes a
      // problem — but an app with `sendChatHistory: false` has no such
      // backstop, so its chats grow for as long as somebody keeps typing, with
      // nothing pushing back. Dropping the oldest is the only trim that leaves
      // the conversation readable from where the reader is.
      const cap = this._messageCap();
      if (cap > 0 && messages.length > cap) {
        const dropped = messages.length - cap;
        messages = messages.slice(dropped);
        this.logger.info('Trimmed the oldest messages of a chat at its cap', {
          component: COMPONENT,
          chatId,
          dropped,
          cap
        });
      }
      await this._writeMessages(chatId, chat.ownerId, messages);

      const patch = { lastMessageAt: entry.ts, messageCount: messages.length };
      if (entry.runId) patch.runIds = trackRunId(chat.runIds, entry.runId);
      // The first user message names the chat, unless the user already did.
      if (!chat.titleSetByUser && !chat.title && entry.role === 'user') {
        const derived = deriveChatTitle(entry.content);
        if (derived) patch.title = derived;
      }
      await this._writeChat(applyChatPatch(chat, patch));

      return { message: entry, messages };
    });
  }

  /**
   * Mark a chat as seen — the counterpart of the `hasUnseenActivity` a turn
   * that finished without a connected client sets.
   *
   * @param {string} chatId - Chat id.
   * @returns {Promise<Object|null>} The stored chat, or null when it does not
   *   exist or cannot be stored.
   */
  async clearUnseen(chatId) {
    return this.updateChat(chatId, { hasUnseenActivity: false });
  }
}

/** @type {ChatRepository|null} */
let cachedRepository = null;
/** @type {import('../../storage/StorageProvider.js').StorageProvider|null} */
let cachedProvider = null;

/**
 * The process-wide chat repository over the bootstrapped storage provider.
 *
 * Rebuilt when the provider changes (a test swapping one in, a shutdown
 * followed by a fresh bootstrap) and cheap enough to call per request. Before
 * storage is up it returns a repository whose every method is a no-op, so
 * callers never branch on initialization order.
 *
 * @returns {ChatRepository}
 */
export function getChatRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ChatRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default ChatRepository;
