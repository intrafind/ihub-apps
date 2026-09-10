/**
 * ConversationStateManager — maps a chatId to the remote iAssistant
 * conversation it belongs to.
 *
 * Two fields carry the whole feature: `conversationId`, so a chat maps to one
 * iFinder conversation instead of creating a new one per turn, and
 * `lastParentId`, so the next message threads onto the previous answer.
 * `baseUrl` routes feedback; `title` and `profileId` are bookkeeping.
 *
 * The state used to live only in a per-process `Map`, which made it a
 * per-worker fact: with `WORKERS > 1` and non-sticky routing, turn 2 of a chat
 * could land on a worker that had never seen it, silently create a *second*
 * remote conversation and reset threading. A restart did the same thing to
 * every live chat. The `integration-conversations` namespace is now the
 * durable copy and the `Map` is a cache in front of it.
 *
 * Two rules shape the write path:
 *
 * - **`updateParentId` runs on every SSE chunk.** Awaiting a document write
 *   there would put a filesystem round-trip on the streaming hot path, so all
 *   mutators stay synchronous and mark the entry dirty; a coalescing timer
 *   writes at most one document per chat per `writeDebounceMs`, and
 *   {@link ConversationStateManager#flush} drains the rest at shutdown.
 * - **No storage provider is a supported state.** Without one this behaves
 *   exactly as it did before: an in-memory map with a 24-hour TTL.
 *
 * The TTL is measured from `createdAt` and is deliberately unchanged,
 * including its wart — a conversation still active after 24 hours is dropped
 * and the adapter transparently starts a new one. Expiry now applies to the
 * stored copy too: an evicted entry takes its document with it, a document
 * read back past its TTL is deleted rather than used, and a bounded page of
 * the namespace is swept on each cleanup tick so documents belonging to a
 * process that has since restarted do not accumulate.
 *
 * @module services/integrations/ConversationStateManager
 */
import logger from '../../utils/logger.js';
import { getStorage } from '../../storage/bootstrap.js';

const COMPONENT = 'ConversationStateManager';

/** Namespace holding one document per chat. */
export const INTEGRATION_CONVERSATIONS_NAMESPACE = 'integration-conversations';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long a change waits before it is written.
 *
 * This is a throttle with a trailing write, not a restarting debounce: the
 * timer is armed by the first change and never re-armed while it is pending,
 * so a chat streaming hundreds of chunks costs one write per second instead of
 * one per chunk — and, unlike a restarting debounce, a long stream still gets
 * its parent id persisted while it is running rather than only at the end.
 */
const DEFAULT_WRITE_DEBOUNCE_MS = 1000;

/** Documents examined per expiry sweep — bounded, and resumed by cursor. */
const SWEEP_PAGE_SIZE = 200;

/**
 * Flush passes before giving up.
 *
 * A pass writes the entries that were dirty when it started; a mutator running
 * during the pass dirties them again. Two extra passes settle any realistic
 * shutdown, and the bound stops a chat that is still streaming from keeping
 * the process alive.
 */
const MAX_FLUSH_PASSES = 3;

/**
 * The document facet of a provider, tolerating one that is absent or throws.
 *
 * @param {Object|null} provider - Storage provider, or null.
 * @returns {import('../../storage/DocumentStore.js').DocumentStore|null}
 */
function readDocuments(provider) {
  try {
    return provider?.documents || null;
  } catch {
    return null;
  }
}

/**
 * Conversation state store: an in-memory cache over a document namespace.
 */
export class ConversationStateManager {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet to persist through. Resolved from the bootstrapped
   *   storage provider on each use when omitted, so an instance constructed
   *   at import time (the module singleton) still finds the provider that
   *   comes up later in the boot sequence.
   * @param {number} [options.ttlMs=86400000] - Age at which an entry expires.
   * @param {number} [options.cleanupIntervalMs=3600000] - Expiry sweep period.
   * @param {number} [options.writeDebounceMs=1000] - Write coalescing window.
   */
  constructor({
    documents = null,
    ttlMs = DEFAULT_TTL_MS,
    cleanupIntervalMs = CLEANUP_INTERVAL_MS,
    writeDebounceMs = DEFAULT_WRITE_DEBOUNCE_MS
  } = {}) {
    this.states = new Map();
    this._documents = documents;
    this._ttlMs = ttlMs;
    this._writeDebounceMs = writeDebounceMs;
    /** Chats whose cached entry has not reached the store yet. @type {Set<string>} */
    this._dirty = new Set();
    this._writeTimer = null;
    /** Cursor carried between expiry sweeps so each tick continues the scan. */
    this._sweepCursor = null;

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
      // Fire-and-forget: the sweep is maintenance, and a failure inside it
      // must not turn into an unhandled rejection on a timer tick.
      void this._sweepExpiredDocuments();
    }, cleanupIntervalMs);
    // Allow Node to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * The document store to persist through, or null when storage is
   * unavailable — which is a supported state, not an error.
   *
   * @returns {import('../../storage/DocumentStore.js').DocumentStore|null}
   */
  _store() {
    return this._documents || readDocuments(getStorage());
  }

  /**
   * Whether an entry (cached or stored) has outlived the TTL.
   *
   * @param {number} createdAt - Creation time in milliseconds.
   * @returns {boolean}
   */
  _isExpired(createdAt) {
    return Number.isFinite(createdAt) && Date.now() - createdAt > this._ttlMs;
  }

  /**
   * Get conversation state for a chat from the cache.
   *
   * Synchronous, and therefore cache-only: it answers for a chat this worker
   * has already handled. Use {@link ConversationStateManager#loadState} to
   * pick up a conversation started on another worker or before a restart.
   *
   * @param {string} chatId
   * @returns {Object|null} Conversation state or null
   */
  getState(chatId) {
    const entry = this.states.get(chatId);
    if (!entry) return null;

    // Check TTL
    if (this._isExpired(entry.createdAt)) {
      this.states.delete(chatId);
      this._markDirty(chatId);
      return null;
    }

    return entry;
  }

  /**
   * Get conversation state for a chat, falling back to the stored copy.
   *
   * This is the read that makes a conversation survive a worker hop and a
   * restart: a cache miss is served from the `integration-conversations`
   * namespace and cached. A stored entry past its TTL is deleted and reported
   * as absent, so the caller starts a fresh conversation exactly as it would
   * have before.
   *
   * @param {string} chatId
   * @returns {Promise<Object|null>} Conversation state or null
   */
  async loadState(chatId) {
    const cached = this.getState(chatId);
    if (cached) return cached;
    if (!chatId) return null;

    const documents = this._store();
    if (!documents) return null;

    try {
      const doc = await documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, chatId);
      const data = doc?.data;
      if (!data || typeof data !== 'object') return null;

      // The document's own `createdAt` is carried across overwrites by the
      // store, so it dates the conversation even if a caller ever omits the
      // field from the body.
      const createdAt = Number.isFinite(data.createdAt)
        ? data.createdAt
        : Date.parse(doc.createdAt);
      if (this._isExpired(createdAt)) {
        await documents.delete(INTEGRATION_CONVERSATIONS_NAMESPACE, chatId);
        return null;
      }

      const entry = { ...data, createdAt };
      this.states.set(chatId, entry);
      return entry;
    } catch (error) {
      // A conversation that cannot be read is one the adapter recreates —
      // worse than a cache hit, no worse than the in-memory-only behaviour.
      logger.warn('Failed to load stored conversation state', {
        component: COMPONENT,
        chatId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Set conversation state for a chat.
   *
   * @param {string} chatId
   * @param {Object} state - { conversationId, lastParentId, title, baseUrl, profileId }
   */
  setState(chatId, state) {
    this.states.set(chatId, {
      ...state,
      createdAt: state.createdAt || Date.now(),
      updatedAt: Date.now()
    });
    this._markDirty(chatId);
  }

  /**
   * Delete state for a chat, in the cache and in the store.
   *
   * @param {string} chatId
   */
  deleteState(chatId) {
    this.states.delete(chatId);
    this._markDirty(chatId);
  }

  /**
   * Update the parent ID after receiving a response_message_id event
   *
   * Called once per streamed chunk that carries a response message id, so it
   * only touches memory and leaves the write to the coalescing timer.
   *
   * @param {string} chatId
   * @param {string} messageId - The response message ID to use as parent for next message
   */
  updateParentId(chatId, messageId) {
    const entry = this.states.get(chatId);
    if (entry) {
      entry.lastParentId = messageId;
      entry.updatedAt = Date.now();
      this._markDirty(chatId);
    } else {
      logger.warn('No state found for chatId when updating parentId', {
        component: COMPONENT,
        chatId
      });
    }
  }

  /**
   * Set the conversation ID (e.g. when client provides an existing conversation to resume)
   * @param {string} chatId
   * @param {string} conversationId
   */
  setConversationId(chatId, conversationId) {
    const entry = this.states.get(chatId);
    if (entry) {
      entry.conversationId = conversationId;
      entry.updatedAt = Date.now();
      this._markDirty(chatId);
    } else {
      // Create minimal state if none exists
      this.setState(chatId, { conversationId });
    }
  }

  /**
   * Mark a chat's document as out of date and make sure a write is coming.
   *
   * @param {string} chatId
   * @returns {void}
   */
  _markDirty(chatId) {
    if (!chatId) return;
    this._dirty.add(chatId);
    if (this._writeTimer || this._writeDebounceMs < 0) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      void this._writeDirty();
    }, this._writeDebounceMs);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  /**
   * Write every dirty chat once.
   *
   * The dirty set is drained before the first await, so a mutation that lands
   * mid-write re-dirties its chat and arms a new timer instead of being lost.
   *
   * @returns {Promise<void>}
   */
  async _writeDirty() {
    if (this._dirty.size === 0) return;
    const documents = this._store();
    if (!documents) {
      // Nothing can be written; drop the backlog rather than growing a set
      // that will never drain on an installation with storage switched off.
      this._dirty.clear();
      return;
    }

    const pending = [...this._dirty];
    this._dirty.clear();

    for (const chatId of pending) {
      const entry = this.states.get(chatId);
      try {
        if (entry) {
          await documents.put(INTEGRATION_CONVERSATIONS_NAMESPACE, chatId, entry);
        } else {
          await documents.delete(INTEGRATION_CONVERSATIONS_NAMESPACE, chatId);
        }
      } catch (error) {
        // Losing a write costs threading on the next turn, not the turn in
        // flight. Re-queueing here would retry a write that fails for a
        // structural reason (an unusable chatId) on every tick forever.
        logger.warn('Failed to persist conversation state', {
          component: COMPONENT,
          chatId,
          error: error.message
        });
      }
    }
  }

  /**
   * Write everything still pending, now.
   *
   * Called on the shutdown path so the parent ids buffered by the coalescing
   * timer reach the store instead of dying with the process. It never
   * rejects — a failed write is logged inside the pass, because a rejection
   * here would skip the shutdown steps queued behind it.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    for (let pass = 0; pass < MAX_FLUSH_PASSES && this._dirty.size > 0; pass += 1) {
      await this._writeDirty();
    }
  }

  /**
   * Clean up expired cache entries, and schedule the removal of their
   * documents — an entry past its TTL is expired for every worker, because
   * they all date it from the same `createdAt`.
   */
  cleanup() {
    let cleaned = 0;
    for (const [chatId, entry] of this.states) {
      if (this._isExpired(entry.createdAt)) {
        this.states.delete(chatId);
        this._markDirty(chatId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info('Cleaned up expired entries', {
        component: COMPONENT,
        count: cleaned
      });
    }
  }

  /**
   * Delete expired documents from one bounded page of the namespace.
   *
   * Cache eviction only reaches documents this worker knows about; anything
   * written before a restart would otherwise sit in the namespace forever.
   * The scan is one page per tick and resumes from the cursor it left off at,
   * so the cost is a fixed, metadata-only listing rather than a walk of the
   * whole namespace. Every candidate is already past the TTL that
   * {@link ConversationStateManager#getState} enforces, so deleting it changes
   * nothing a caller could observe.
   *
   * @returns {Promise<number>} How many documents were removed.
   */
  async _sweepExpiredDocuments() {
    const documents = this._store();
    if (!documents) return 0;

    let removed = 0;
    try {
      const page = await documents.list(INTEGRATION_CONVERSATIONS_NAMESPACE, {
        limit: SWEEP_PAGE_SIZE,
        includeData: false,
        ...(this._sweepCursor ? { cursor: this._sweepCursor } : {})
      });
      this._sweepCursor = page.nextCursor || null;

      for (const doc of page.items) {
        if (!this._isExpired(Date.parse(doc.createdAt))) continue;
        if (this.states.has(doc.key)) continue;
        if (await documents.delete(INTEGRATION_CONVERSATIONS_NAMESPACE, doc.key)) removed += 1;
      }
    } catch (error) {
      // An unusable cursor (a namespace rewritten under us, a provider swap)
      // is recoverable by starting the scan over on the next tick.
      this._sweepCursor = null;
      logger.warn('Conversation state expiry sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    }

    if (removed > 0) {
      logger.info('Removed expired conversation state documents', {
        component: COMPONENT,
        count: removed
      });
    }
    return removed;
  }

  /**
   * Stop the timers this instance owns. Pending writes are not flushed —
   * call {@link ConversationStateManager#flush} first when they matter.
   *
   * @returns {void}
   */
  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = null;
  }

  /**
   * Get current state count (for monitoring)
   */
  get size() {
    return this.states.size;
  }
}

/**
 * Process-wide conversation state manager.
 *
 * @type {ConversationStateManager}
 */
export default new ConversationStateManager();
