// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where evidence records live (#3687, `docs/chat-evidence.md`).
 *
 * An evidence record says what went into every model call and tool call of
 * one answer. The record is a small document; everything it refers to by
 * SHA-256 (system prompts, messages, tool definitions, tool arguments and
 * results) is an item. The items an answer stores go into ONE blob, the
 * answer's pack — two durable writes per answer (pack, record):
 *
 * | Namespace               | Key                                     | Kind     |
 * | ----------------------- | --------------------------------------- | -------- |
 * | `chat-evidence`         | `<scope(chatId)>__<scope(messageId)>`   | document |
 * | `chat-evidence-content` | `<scope(chatId)>__<scope(messageId)>`   | pack     |
 * | `run-evidence`          | `<runId>` (owned by the caller)          | document |
 * | `run-evidence-content`  | `<scope(runId)>__<scope(runId)>`        | pack     |
 *
 * `scope(id)` is the first 32 hex characters of sha256(id): chat ids are
 * external strings and may contain characters a key cannot. Deleting a chat's
 * evidence is two prefix deletes.
 *
 * A pack is the canonical JSON object `{ "<sha256>": <item>, ... }`; an item's
 * SHA-256 is that of its own canonical JSON (`contentItem`). A record (v2)
 * maps every item it names to the answer whose pack holds it
 * (`content: { "<sha256>": "<messageId>" }`; the run id for a run record). An
 * item the chat's previous record already maps is not stored again: the new
 * record points into the older pack. An item larger than `maxContentBytes` is
 * not collected at all; the record lists it under `truncated` (see
 * `evidenceRecord.js`). Removing a message's record sweeps the packs no
 * remaining record of the chat points into.
 *
 * @module services/chat/ChatEvidenceRepository
 */
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { BLOB_NAMESPACES, RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { canonicalJson } from '../../storage/canonicalJson.js';
import { CorruptDocumentError } from '../../storage/errors.js';
import { walkBlobs, walkDocuments } from '../../storage/walk.js';

/** Namespaces per kind of record. */
const NAMESPACES = Object.freeze({
  chat: { doc: RUNTIME_NAMESPACES.chatEvidence, content: BLOB_NAMESPACES.chatEvidenceContent },
  run: { doc: RUNTIME_NAMESPACES.runEvidence, content: BLOB_NAMESPACES.runEvidenceContent }
});

/** Version of the record shape: v2 maps its items to packs (`content`). */
export const EVIDENCE_VERSION = 2;

/**
 * Lease of the evidence lock. Generous: the holder writes a record's blobs,
 * off the answer path, and a waiter is a background write or a delete.
 * Unfenced: no section reads the fencing token.
 */
const LOCK_OPTIONS = { ttlMs: 60_000, waitMs: 30_000, fence: false };

/** The same lease for a delete, which must not keep a request waiting long. */
const DELETE_LOCK_OPTIONS = { ttlMs: 60_000, waitMs: 5_000, fence: false };

/** A content hash as the endpoints accept it. */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * sha256 hex of a string or buffer.
 *
 * @param {string|Buffer} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The key segment of an external id: 32 hex characters of its sha256.
 *
 * @param {string} id
 * @returns {string}
 */
export function evidenceScope(id) {
  return sha256Hex(String(id)).slice(0, 32);
}

/**
 * Serialize one content item and hash it — what the record refers to and
 * a pack holds under that hash.
 *
 * @param {any} value - JSON-serializable item.
 * @returns {{sha256: string, text: string}}
 */
export function contentItem(value) {
  const text = canonicalJson(value === undefined ? null : value);
  return { sha256: sha256Hex(text), text };
}

/** Background evidence work (record writes, sweeps) still in flight. */
const pending = new Set();

/**
 * Run evidence work in the background: never awaited by the caller, never
 * rejects (a failure is logged), tracked until it settles.
 *
 * @param {() => Promise<any>} work
 * @param {Object} context - Logged with a failure.
 * @returns {Promise<any>} Resolves to the work's result, or null after a failure.
 */
export function inBackground(work, context) {
  const promise = Promise.resolve()
    .then(work)
    .catch(error => {
      logger.error('Evidence work failed', { ...context, error: error.message });
      return null;
    })
    .finally(() => pending.delete(promise));
  pending.add(promise);
  return promise;
}

/**
 * Wait until every background evidence write and sweep started so far has
 * settled (tests, a graceful shutdown).
 *
 * @returns {Promise<void>}
 */
export async function evidenceWritesSettled() {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Evidence records and their content.
 */
export class ChatEvidenceRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {import('../../storage/BlobStore.js').BlobStore|null} [options.blobs]
   *   Both facets are needed; without either every method is a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Serializes a chat's record writes, content sweeps and deletes
   *   (`evidence:<scope(chatId)>`). Without it they run unserialized.
   * @param {Object} [options.logger]
   */
  constructor({ documents = null, blobs = null, locks = null, logger: log } = {}) {
    this.documents = documents || null;
    this.blobs = blobs || null;
    this.locks = locks || null;
    this.logger = log || logger;
  }

  /**
   * Run `fn` under the evidence lock of one chat or run.
   *
   * @param {string} id - Chat id or run id.
   * @param {() => Promise<any>} fn
   * @param {Object} [options] - Lease and wait; a delete waits briefly.
   * @returns {Promise<any>}
   * @private
   */
  _withLock(id, fn, options = LOCK_OPTIONS) {
    if (!this.locks) return fn();
    return this.locks.withLock(`evidence:${evidenceScope(id)}`, fn, options);
  }

  /** Whether this repository can store anything. @returns {boolean} */
  isAvailable() {
    return Boolean(this.documents && this.blobs);
  }

  /**
   * Document key and content prefix of a record.
   *
   * @param {'chat'|'run'} kind
   * @param {string} id - Chat id or run id.
   * @param {string} [messageId] - The answer's message id (chat records).
   * @returns {{docKey: string, prefix: string}}
   * @private
   */
  _keys(kind, id, messageId) {
    const prefix = `${evidenceScope(id)}__`;
    const docKey = kind === 'chat' ? `${prefix}${evidenceScope(messageId)}` : id;
    return { docKey, prefix };
  }

  /**
   * Key of the pack an answer (chat) or a run wrote.
   *
   * @param {string} id - Chat id or run id.
   * @param {string} packId - The answer's message id; the run id for a run.
   * @returns {string}
   * @private
   */
  _packKey(id, packId) {
    return `${evidenceScope(id)}__${evidenceScope(packId)}`;
  }

  /**
   * The `content` map of the chat's previous record: that of the newest
   * earlier answer that has a record at all. A record of another version
   * (v1, no map) means no previous record — older ones are not newer.
   *
   * @param {string} chatId
   * @param {string[]} earlierMessageIds - Earlier answers, newest first.
   * @returns {Promise<Object<string, string>>} sha256 → message id of its pack.
   * @private
   */
  async _previousContent(chatId, earlierMessageIds) {
    for (const messageId of earlierMessageIds) {
      const doc = await this.documents.get(
        NAMESPACES.chat.doc,
        this._keys('chat', chatId, messageId).docKey
      );
      if (doc) return doc.data?.v === EVIDENCE_VERSION ? doc.data.content || {} : {};
    }
    return {};
  }

  /**
   * Store a record and the content it refers to, under the evidence lock:
   * the answer's pack (the items not stored yet), then the record — two
   * durable writes, one when there is nothing new.
   *
   * Dedup without listing: `onlyIf` of a chat record returns the chat's
   * earlier answers; items the previous record maps are referenced to the pack
   * named there and not stored again. The history every answer's first call
   * lists is covered by the previous record, so an answer mostly stores what
   * it added. An item last used two answers ago is stored again — accepted.
   *
   * @param {'chat'|'run'} kind
   * @param {string} id - Chat id (chat) or run id (run).
   * @param {Object} record - The record; a chat record carries `messageId`.
   *   Stored as v2 with the `content` map added.
   * @param {Map<string, string>} items - sha256 → canonical JSON text.
   * @param {Object} [options]
   * @param {string|null} [options.ownerId] - Owning principal.
   * @param {() => Promise<boolean|string[]>} [options.onlyIf] - Judged under
   *   the lock before anything is written: false writes nothing (the chat is
   *   gone). For a chat record it may return the message ids of the chat's
   *   earlier answers, newest first, to dedup against the previous record.
   * @returns {Promise<{id: string, sha256: string}|null>} The record's id
   *   (message id or run id) and the etag of the stored document; null when
   *   nothing was written. Once per record id: when the record is already
   *   stored, nothing is written and its id and etag come back — a second
   *   write would replace the pack later records point into.
   */
  async writeRecord(kind, id, record, items, { ownerId = null, onlyIf } = {}) {
    if (!this.isAvailable()) return null;
    const ns = NAMESPACES[kind];
    const recordId = kind === 'chat' ? record.messageId : id;
    if (!ns || !id || !recordId || (kind === 'run' && !isValidId(id))) return null;
    const { docKey } = this._keys(kind, id, record.messageId);
    return this._withLock(id, async () => {
      const existing = await this.documents.get(ns.doc, docKey);
      if (existing) return { id: recordId, sha256: existing.etag };
      const allowed = onlyIf ? await onlyIf() : true;
      if (!allowed) return null;
      const previous =
        kind === 'chat' && Array.isArray(allowed) ? await this._previousContent(id, allowed) : {};
      const content = {};
      const fresh = [];
      for (const [sha256, text] of items) {
        const packId = typeof previous[sha256] === 'string' ? previous[sha256] : null;
        content[sha256] = packId || recordId;
        if (!packId) fresh.push([sha256, text]);
      }
      const packKey = this._packKey(id, recordId);
      try {
        if (fresh.length > 0) {
          // Canonical JSON of `{ sha256: item }` without re-serializing the
          // items: their text already is canonical, the keys go in sorted.
          fresh.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          const pack = `{${fresh.map(([sha256, text]) => `"${sha256}":${text}`).join(',')}}`;
          await this.blobs.put(ns.content, packKey, pack, { contentType: 'application/json' });
        }
        const doc = await this.documents.put(
          ns.doc,
          docKey,
          { ...record, v: EVIDENCE_VERSION, content },
          { ownerId }
        );
        return { id: recordId, sha256: doc.etag };
      } catch (error) {
        // A pack without its record is reached by nothing: take it back. Only
        // then — a put can reject after the document was committed (a cleanup
        // after the write), and that record names this pack.
        if (fresh.length > 0) {
          const committed = await this.documents.get(ns.doc, docKey).catch(() => null);
          if (!committed) await this.blobs.delete(ns.content, packKey).catch(() => {});
        }
        throw error;
      }
    });
  }

  /**
   * One record, as stored (data, ownerId, etag).
   *
   * @param {'chat'|'run'} kind
   * @param {string} id - Chat id or run id.
   * @param {string} [messageId] - For a chat record.
   * @returns {Promise<Object|null>}
   */
  async getRecord(kind, id, messageId) {
    if (!this.isAvailable() || !NAMESPACES[kind] || !id) return null;
    if (kind === 'chat' && !messageId) return null;
    if (kind === 'run' && !isValidId(id)) return null;
    return this.documents.get(NAMESPACES[kind].doc, this._keys(kind, id, messageId).docKey);
  }

  /**
   * One item a record names: record → `content[sha256]` → pack → item.
   *
   * ponytail: reads and parses the whole pack for one item (a first answer's
   * pack holds the history). Index the pack if item reads show up in a profile.
   *
   * @param {'chat'|'run'} kind
   * @param {string} id - Chat id or run id.
   * @param {Object} record - The record's data, as `getRecord` returned it.
   * @param {string} sha256 - Content hash.
   * @returns {Promise<Buffer|null>} The item's canonical JSON; null when the
   *   record does not map it (a v1 record maps nothing) or its pack is gone.
   */
  async getContent(kind, id, record, sha256) {
    if (!this.isAvailable() || !NAMESPACES[kind] || !id || !SHA256_PATTERN.test(sha256)) {
      return null;
    }
    if (record?.v !== EVIDENCE_VERSION) return null;
    const packId = record.content?.[sha256];
    if (typeof packId !== 'string' || !packId) return null;
    const blob = await this.blobs.get(NAMESPACES[kind].content, this._packKey(id, packId));
    let pack = null;
    if (blob?.data) {
      try {
        pack = JSON.parse(blob.data.toString('utf8'));
      } catch {
        this.logger.error('Evidence pack is not valid JSON', { kind, id, packId });
        return null;
      }
    }
    // The record maps it, so it should be there: a hole in the evidence.
    if (!pack || typeof pack !== 'object' || !Object.hasOwn(pack, sha256)) {
      this.logger.warn('Evidence item missing from its pack', { kind, id, packId, sha256 });
      return null;
    }
    return Buffer.from(canonicalJson(pack[sha256]), 'utf8');
  }

  /**
   * Remove the records of some answers of a chat (an edit or resend dropped
   * them), then the packs no remaining record of the chat points into.
   *
   * @param {string} chatId
   * @param {string[]} messageIds
   * @returns {Promise<number>} Records removed.
   */
  async deleteMessages(chatId, messageIds) {
    if (!this.isAvailable() || !chatId) return 0;
    return this._withLock(
      chatId,
      async () => {
        let removed = 0;
        for (const messageId of messageIds || []) {
          if (typeof messageId !== 'string' || !messageId) continue;
          const { docKey } = this._keys('chat', chatId, messageId);
          if (await this.documents.delete(NAMESPACES.chat.doc, docKey)) removed += 1;
        }
        if (removed > 0) await this._sweepChatPacks(chatId);
        return removed;
      },
      DELETE_LOCK_OPTIONS
    );
  }

  /**
   * Mark and sweep one chat's packs: delete every blob no record's `content`
   * map points into. A pack whose answer was removed stays while a later
   * record still refers to it. Runs under the evidence lock, so no write is
   * half done.
   *
   * @param {string} chatId
   * @returns {Promise<number>} Blobs removed.
   * @private
   */
  async _sweepChatPacks(chatId) {
    const prefix = `${evidenceScope(chatId)}__`;
    const referenced = new Set();
    try {
      // `throw`: a record that is present but does not open still refers to
      // its packs. Walked leniently it would count as absent and its content
      // would be deleted for good.
      for await (const doc of walkDocuments(this.documents, NAMESPACES.chat.doc, {
        prefix,
        unreadable: 'throw'
      })) {
        for (const packId of Object.values(doc.data?.content || {})) {
          if (typeof packId === 'string') referenced.add(this._packKey(chatId, packId));
        }
      }
    } catch (error) {
      if (!(error instanceof CorruptDocumentError)) throw error;
      this.logger.warn(
        'An evidence record of this chat cannot be read; its content packs are kept this time',
        { component: 'ChatEvidenceRepository', chatId, code: error.code }
      );
      return 0;
    }
    const unreferenced = [];
    for await (const item of walkBlobs(this.blobs, NAMESPACES.chat.content, { prefix })) {
      if (!referenced.has(item.key)) unreferenced.push(item.key);
    }
    for (const key of unreferenced) await this.blobs.delete(NAMESPACES.chat.content, key);
    return unreferenced.length;
  }

  /**
   * Remove all evidence of a chat: its records and its content.
   *
   * @param {string} chatId
   * @returns {Promise<number>} Documents and blobs removed.
   */
  async deleteChat(chatId) {
    if (!this.isAvailable() || !chatId) return 0;
    const prefix = `${evidenceScope(chatId)}__`;
    return this._withLock(
      chatId,
      async () =>
        (await this.documents.deletePrefix(NAMESPACES.chat.doc, prefix)) +
        (await this.blobs.deletePrefix(NAMESPACES.chat.content, prefix)),
      DELETE_LOCK_OPTIONS
    );
  }

  /**
   * Remove the evidence of one run without a chat.
   *
   * @param {string} runId
   * @returns {Promise<boolean>} Whether the record existed.
   */
  async deleteRun(runId) {
    if (!this.isAvailable() || !isValidId(runId)) return false;
    return this._withLock(
      runId,
      async () => {
        // Content first: a record whose pack went is still found and deleted
        // again; a pack whose record went is found by nothing.
        await this.blobs.deletePrefix(NAMESPACES.run.content, `${evidenceScope(runId)}__`);
        return this.documents.delete(NAMESPACES.run.doc, runId);
      },
      DELETE_LOCK_OPTIONS
    );
  }

  /**
   * Remove the chat evidence records filed under an owner, with the content
   * of their chats — what a failed chat delete may have left behind (a
   * deleted user's cleanup).
   *
   * @param {string} ownerId
   * @returns {Promise<number>} Records removed.
   */
  async deleteChatEvidenceOfOwner(ownerId) {
    if (!this.isAvailable() || !ownerId) return 0;
    const scopes = new Set();
    for await (const doc of walkDocuments(this.documents, NAMESPACES.chat.doc, {
      ownerId,
      includeData: false
    })) {
      scopes.add(doc.key.slice(0, doc.key.indexOf('__')));
    }
    let removed = 0;
    for (const scope of scopes) {
      const prefix = `${scope}__`;
      removed += await this.documents.deletePrefix(NAMESPACES.chat.doc, prefix);
      await this.blobs.deletePrefix(NAMESPACES.chat.content, prefix);
    }
    return removed;
  }

  /**
   * Remove the run evidence of one owner (a deleted user account).
   *
   * @param {string} ownerId
   * @returns {Promise<number>} Records removed.
   */
  async deleteRunsOfOwner(ownerId) {
    if (!this.isAvailable() || !ownerId) return 0;
    const runIds = [];
    for await (const doc of walkDocuments(this.documents, NAMESPACES.run.doc, {
      ownerId,
      includeData: false
    })) {
      runIds.push(doc.key);
    }
    let removed = 0;
    for (const runId of runIds) if (await this.deleteRun(runId)) removed += 1;
    return removed;
  }

  /**
   * Remove run evidence stored before `cutoffMs` — the age rule of
   * `chats.retentionDays`, applied to runs without a chat.
   *
   * @param {number} cutoffMs - Epoch milliseconds.
   * @returns {Promise<number>} Records removed.
   */
  async sweepRuns(cutoffMs) {
    if (!this.isAvailable() || !Number.isFinite(cutoffMs)) return 0;
    const expired = [];
    for await (const doc of walkDocuments(this.documents, NAMESPACES.run.doc, {
      includeData: false
    })) {
      const createdAt = Date.parse(doc.createdAt);
      if (Number.isFinite(createdAt) && createdAt < cutoffMs) expired.push(doc.key);
    }
    let removed = 0;
    for (const runId of expired) if (await this.deleteRun(runId)) removed += 1;
    return removed;
  }

  /**
   * Bytes the evidence of one chat takes: its records and its packs.
   *
   * @param {string} chatId
   * @returns {Promise<number>}
   */
  async chatBytes(chatId) {
    if (!this.isAvailable() || !chatId) return 0;
    const prefix = `${evidenceScope(chatId)}__`;
    let total = 0;
    for await (const doc of walkDocuments(this.documents, NAMESPACES.chat.doc, {
      prefix,
      includeData: false
    })) {
      total += doc.size || 0;
    }
    for await (const item of walkBlobs(this.blobs, NAMESPACES.chat.content, { prefix })) {
      total += item.bytes || 0;
    }
    return total;
  }
}

let cachedProvider = null;
let cachedRepository = null;

/**
 * The repository over the active storage provider; rebuilt when the provider
 * changes (tests, a restart of the storage layer).
 *
 * @returns {ChatEvidenceRepository}
 */
export function getChatEvidenceRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ChatEvidenceRepository({
      documents: readFacet(provider, 'documents'),
      blobs: readFacet(provider, 'blobs'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default ChatEvidenceRepository;
