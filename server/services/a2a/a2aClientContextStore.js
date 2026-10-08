/**
 * Conversation memory of the outbound A2A client: which `contextId` (and,
 * while the agent waits for the user's answer, which `taskId`) a chat has with
 * a remote agent, per (user, chat, agent).
 *
 * Entries are documents on the storage provider (`a2a-client-contexts`),
 * owned by the user, so a chat keeps its conversation with an agent across
 * restarts and whichever worker serves the next tool call. Each worker keeps
 * a bounded in-memory copy; the document is read first, so an update another
 * worker made wins. Without a provider the store is memory-only.
 *
 * @module services/a2a/a2aClientContextStore
 */
import { createHash } from 'node:crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'A2aClientContextStore';

export const A2A_CLIENT_CONTEXTS_NAMESPACE = RUNTIME_NAMESPACES.a2aClientContexts;

/** Conversations nobody continued for this long are dropped. */
export const CLIENT_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Conversations held in memory per worker before the oldest are dropped. */
export const MAX_REMEMBERED_CONTEXTS = 5000;

/** Documents looked at per retention sweep. */
const SWEEP_PAGE_SIZE = 200;

/**
 * Storage key of a conversation. The digest keeps the key path-safe and of
 * fixed length whatever the user and chat ids hold.
 *
 * @param {{userId: string, chatId: string, agentId: string}} ref
 * @returns {string}
 */
export function clientContextKey({ userId, chatId, agentId }) {
  const digest = createHash('sha256')
    .update(`${userId}\u0000${chatId}\u0000${agentId}`)
    .digest('hex')
    .slice(0, 40);
  return `cctx_${digest}`;
}

/**
 * The (user, chat, agent) a tool call belongs to, or null for a call made
 * outside a chat of a known user (nothing is remembered for it).
 *
 * @param {Object} params - Params as handed to `runTool`
 * @param {string} agentId
 * @returns {{userId: string, chatId: string, agentId: string}|null}
 */
export function clientContextRef(params, agentId) {
  const userId = params?.user?.id;
  const chatId = params?.chatId;
  if (typeof userId !== 'string' || !userId || typeof chatId !== 'string' || !chatId) return null;
  return { userId, chatId, agentId };
}

export class A2aClientContextStore {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents] -
   *   Document store to persist to. `null` pins memory-only mode; leaving it
   *   out resolves the storage provider lazily on each use.
   * @param {() => number} [options.now]
   */
  constructor({ documents, now = () => Date.now() } = {}) {
    this._documents = documents;
    this._pinned = documents !== undefined;
    this.now = now;
    /** @type {Map<string, {contextId: string|null, taskId?: string, updatedAt: number}>} LRU-ordered */
    this.entries = new Map();
    /** Cursor of the next sweep page, so successive ticks page through the
     *  whole namespace instead of re-reading the same page forever. */
    this._sweepCursor = null;
  }

  _docs() {
    if (this._pinned) return this._documents || null;
    return readFacet(getStorage(), 'documents');
  }

  _cache(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_REMEMBERED_CONTEXTS) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  /**
   * The remembered conversation of a (user, chat, agent), or null.
   *
   * @param {{userId: string, chatId: string, agentId: string}} ref
   * @returns {Promise<{contextId: string|null, taskId?: string}|null>}
   */
  async get(ref) {
    const key = clientContextKey(ref);
    let entry = this.entries.get(key) || null;
    const documents = this._docs();
    if (documents) {
      try {
        const doc = await documents.get(A2A_CLIENT_CONTEXTS_NAMESPACE, key);
        // The document holds the ids it is for, so a digest collision (or a
        // stale copy of another conversation) can never be handed out.
        const data = doc?.data;
        entry =
          data &&
          data.userId === ref.userId &&
          data.chatId === ref.chatId &&
          data.agentId === ref.agentId
            ? {
                contextId: data.contextId || null,
                ...(data.taskId ? { taskId: data.taskId } : {}),
                updatedAt: data.updatedAt || 0
              }
            : null;
      } catch (error) {
        logger.warn('A2A conversation read failed; using in-memory copy', {
          component: COMPONENT,
          agentId: ref.agentId,
          error: error.message
        });
      }
    }
    if (!entry) {
      this.entries.delete(key);
      return null;
    }
    if (this.now() - (entry.updatedAt || 0) > CLIENT_CONTEXT_RETENTION_MS) return null;
    this._cache(key, entry);
    return { contextId: entry.contextId, ...(entry.taskId ? { taskId: entry.taskId } : {}) };
  }

  /**
   * Remember the conversation of a (user, chat, agent) — or, with neither id,
   * forget it.
   *
   * @param {{userId: string, chatId: string, agentId: string}} ref
   * @param {{contextId?: string|null, taskId?: string}} [entry]
   * @returns {Promise<void>}
   */
  async set(ref, { contextId, taskId } = {}) {
    const key = clientContextKey(ref);
    const documents = this._docs();
    if (!contextId && !taskId) {
      this.entries.delete(key);
      if (!documents) return;
      try {
        await documents.delete(A2A_CLIENT_CONTEXTS_NAMESPACE, key);
      } catch (error) {
        logger.warn('A2A conversation delete failed', {
          component: COMPONENT,
          agentId: ref.agentId,
          error: error.message
        });
      }
      return;
    }
    const entry = {
      contextId: contextId || null,
      ...(taskId ? { taskId } : {}),
      updatedAt: this.now()
    };
    this._cache(key, entry);
    if (!documents) return;
    try {
      await documents.put(
        A2A_CLIENT_CONTEXTS_NAMESPACE,
        key,
        { userId: ref.userId, chatId: ref.chatId, agentId: ref.agentId, ...entry },
        { ownerId: ref.userId }
      );
    } catch (error) {
      logger.warn('A2A conversation write failed; it is remembered on this worker only', {
        component: COMPONENT,
        agentId: ref.agentId,
        error: error.message
      });
    }
  }

  /** Forget everything this worker holds in memory (the documents stay). */
  clearMemory() {
    this.entries.clear();
  }

  /**
   * Drop conversations past their retention. Looks at one bounded page per
   * call, so the sweep stays cheap and catches up over successive ticks.
   *
   * @returns {Promise<number>} How many were removed
   */
  async sweep() {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - (entry.updatedAt || 0) > CLIENT_CONTEXT_RETENTION_MS) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    const documents = this._docs();
    if (!documents) return removed;
    try {
      const page = await documents.list(A2A_CLIENT_CONTEXTS_NAMESPACE, {
        limit: SWEEP_PAGE_SIZE,
        cursor: this._sweepCursor || undefined
      });
      for (const doc of page.items || []) {
        const updatedAt = doc.data?.updatedAt || Date.parse(doc.updatedAt) || 0;
        if (now - updatedAt > CLIENT_CONTEXT_RETENTION_MS) {
          if (await documents.delete(A2A_CLIENT_CONTEXTS_NAMESPACE, doc.key)) removed += 1;
        }
      }
      this._sweepCursor = page.nextCursor || null;
    } catch (error) {
      this._sweepCursor = null;
      logger.warn('A2A conversation sweep failed', { component: COMPONENT, error: error.message });
    }
    return removed;
  }
}
