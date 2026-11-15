// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where evidence records live (#3687, `docs/chat-evidence.md`).
 *
 * An evidence record says what went into every model call and tool call of
 * one answer. The record is a small document; everything it refers to by
 * SHA-256 (system prompts, messages, tool definitions, tool arguments and
 * results) is a blob, stored once per chat however often it was sent:
 *
 * | Namespace               | Key                                     | Kind     |
 * | ----------------------- | --------------------------------------- | -------- |
 * | `chat-evidence`         | `<scope(chatId)>__<scope(messageId)>`   | document |
 * | `chat-evidence-content` | `<scope(chatId)>__<sha256>`             | blob     |
 * | `run-evidence`          | `<runId>` (owned by the caller)          | document |
 * | `run-evidence-content`  | `<scope(runId)>__<sha256>`              | blob     |
 *
 * `scope(id)` is the first 32 hex characters of sha256(id): chat ids are
 * external strings and may contain characters a key cannot. Deleting a chat's
 * evidence is two prefix deletes; nothing is reference-counted.
 *
 * Every content blob is the canonical JSON of its item (`canonicalJson`), and
 * its SHA-256 is the hash the record names. An item larger than
 * `maxContentBytes` is not collected at all; the record lists it under
 * `truncated` (see `evidenceRecord.js`). Removing a message's record sweeps
 * the chat's content no remaining record refers to.
 *
 * @module services/chat/ChatEvidenceRepository
 */
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { BLOB_NAMESPACES, RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { canonicalJson } from '../../storage/canonicalJson.js';
import { walkBlobs, walkDocuments } from '../../storage/walk.js';

/** Namespaces per kind of record. */
const NAMESPACES = Object.freeze({
  chat: { doc: RUNTIME_NAMESPACES.chatEvidence, content: BLOB_NAMESPACES.chatEvidenceContent },
  run: { doc: RUNTIME_NAMESPACES.runEvidence, content: BLOB_NAMESPACES.runEvidenceContent }
});

/** Blob writes of one record in flight at a time. */
const PUT_CONCURRENCY = 8;

/**
 * Lease of the evidence lock. Generous: the holder writes a record's blobs,
 * off the answer path, and a waiter is a background write or a delete.
 */
const LOCK_OPTIONS = { ttlMs: 60_000, waitMs: 30_000 };

/** A content reference inside a record. */
const CONTENT_REF = /sha256:([a-f0-9]{64})/g;

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
 * the blob holds.
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
   * @returns {Promise<any>}
   * @private
   */
  _withLock(id, fn) {
    if (!this.locks) return fn();
    return this.locks.withLock(`evidence:${evidenceScope(id)}`, fn, LOCK_OPTIONS);
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
   * Store a record and the content it refers to, under the evidence lock.
   *
   * Lists the scope's blobs once and writes only those not stored yet (at
   * most {@link PUT_CONCURRENCY} at a time), then the record.
   *
   * ponytail: one listing of the scope per write — O(blobs of the chat). Keep
   * a per-chat index document if long chats make it show up in a profile.
   *
   * @param {'chat'|'run'} kind
   * @param {string} id - Chat id (chat) or run id (run).
   * @param {Object} record - The record; a chat record carries `messageId`.
   * @param {Map<string, string>} items - sha256 → canonical JSON text.
   * @param {Object} [options]
   * @param {string|null} [options.ownerId] - Owning principal.
   * @param {() => Promise<boolean>} [options.onlyIf] - Judged under the lock
   *   before anything is written: false writes nothing (the chat is gone).
   * @returns {Promise<{id: string, sha256: string}|null>} The record's id
   *   (message id or run id) and the etag of the stored document; null when
   *   nothing was written.
   */
  async writeRecord(kind, id, record, items, { ownerId = null, onlyIf } = {}) {
    if (!this.isAvailable()) return null;
    const ns = NAMESPACES[kind];
    const recordId = kind === 'chat' ? record.messageId : id;
    if (!ns || !id || !recordId || (kind === 'run' && !isValidId(id))) return null;
    const { docKey, prefix } = this._keys(kind, id, record.messageId);
    return this._withLock(id, async () => {
      if (onlyIf && !(await onlyIf())) return null;
      const stored = new Set();
      for await (const item of walkBlobs(this.blobs, ns.content, { prefix })) {
        stored.add(item.key);
      }
      const missing = [...items].filter(([sha256]) => !stored.has(`${prefix}${sha256}`));
      for (let at = 0; at < missing.length; at += PUT_CONCURRENCY) {
        await Promise.all(
          missing.slice(at, at + PUT_CONCURRENCY).map(([sha256, text]) =>
            this.blobs.put(ns.content, `${prefix}${sha256}`, text, {
              contentType: 'application/json'
            })
          )
        );
      }
      const doc = await this.documents.put(ns.doc, docKey, record, { ownerId });
      return { id: recordId, sha256: doc.etag };
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
   * One content blob.
   *
   * @param {'chat'|'run'} kind
   * @param {string} id - Chat id or run id.
   * @param {string} sha256 - Content hash.
   * @returns {Promise<Buffer|null>}
   */
  async getContent(kind, id, sha256) {
    if (!this.isAvailable() || !NAMESPACES[kind] || !id || !SHA256_PATTERN.test(sha256)) {
      return null;
    }
    const blob = await this.blobs.get(NAMESPACES[kind].content, `${evidenceScope(id)}__${sha256}`);
    return blob?.data || null;
  }

  /**
   * Remove the records of some answers of a chat (an edit or resend dropped
   * them), then the content no remaining record of the chat refers to.
   *
   * @param {string} chatId
   * @param {string[]} messageIds
   * @returns {Promise<number>} Records removed.
   */
  async deleteMessages(chatId, messageIds) {
    if (!this.isAvailable() || !chatId) return 0;
    return this._withLock(chatId, async () => {
      let removed = 0;
      for (const messageId of messageIds || []) {
        if (typeof messageId !== 'string' || !messageId) continue;
        const { docKey } = this._keys('chat', chatId, messageId);
        if (await this.documents.delete(NAMESPACES.chat.doc, docKey)) removed += 1;
      }
      if (removed > 0) await this._sweepChatContent(chatId);
      return removed;
    });
  }

  /**
   * Mark and sweep one chat's content: delete every blob none of its records
   * names. Runs under the evidence lock, so no write is half done.
   *
   * @param {string} chatId
   * @returns {Promise<number>} Blobs removed.
   * @private
   */
  async _sweepChatContent(chatId) {
    const prefix = `${evidenceScope(chatId)}__`;
    const referenced = new Set();
    for await (const doc of walkDocuments(this.documents, NAMESPACES.chat.doc, { prefix })) {
      for (const match of JSON.stringify(doc.data ?? null).matchAll(CONTENT_REF)) {
        referenced.add(match[1]);
      }
    }
    const unreferenced = [];
    for await (const item of walkBlobs(this.blobs, NAMESPACES.chat.content, { prefix })) {
      if (!referenced.has(item.key.slice(prefix.length))) unreferenced.push(item.key);
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
        (await this.blobs.deletePrefix(NAMESPACES.chat.content, prefix))
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
    const removed = await this.documents.delete(NAMESPACES.run.doc, runId);
    await this.blobs.deletePrefix(NAMESPACES.run.content, `${evidenceScope(runId)}__`);
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
   * Bytes the evidence of one chat takes: its records and its content.
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
