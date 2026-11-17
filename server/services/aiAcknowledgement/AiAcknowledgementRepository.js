// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a user's AI-use acknowledgements live: one small document per user in
 * the runtime namespace `ai-acknowledgements`, keyed `ack_<hash(userId)>` and
 * owned by the user.
 *
 * ```json
 * { "version": 1, "userId": "alice",
 *   "aiAcknowledgements": [{ "version": 2, "textHash": "sha256:…", "acknowledgedAt": "…", "language": "en" }],
 *   "aiAcknowledgementsClearedAt": "…" }
 * ```
 *
 * The two fields carry the names and shapes they had on the users.json record,
 * so the rules in `aiAcknowledgementService` (`isAcknowledged`, `statusOfUser`)
 * read a document exactly as they read a record.
 *
 * Why not users.json: a confirmation there rewrote the whole user file under
 * one lock and made every worker reload it, which a sign-in wave turned into
 * lock timeouts (503). Here a confirmation is one compare-and-set `put` of a
 * document of a few hundred bytes, and every worker and pod reads the same
 * store, so there is nothing to reload or to sync.
 *
 * Writes are compare-and-set on the document's etag, retried a few times: the
 * only contention is one user confirming twice at once.
 *
 * @module services/aiAcknowledgement/AiAcknowledgementRepository
 */
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { forgetAcknowledgement } from './acknowledgementCache.js';

/** Namespace holding one document per user. */
export const AI_ACKNOWLEDGEMENTS_NAMESPACE = RUNTIME_NAMESPACES.aiAcknowledgements;

/** Schema version stamped on every document written here. */
export const AI_ACKNOWLEDGEMENT_DOC_VERSION = 1;

/** Compare-and-set attempts before a write gives up. */
const MAX_ATTEMPTS = 5;

/** Documents per page when walking the namespace. */
const PAGE_SIZE = 1000;

/**
 * Key of one user's document. A hash, because user ids may hold characters a
 * storage key may not; the document names its user, and a read checks it.
 *
 * Migration V255 computes the same key (as a snapshot); change both or neither.
 *
 * @param {string} userId
 * @returns {string}
 */
export function acknowledgementKey(userId) {
  return `ack_${createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
}

/** The document's data when it belongs to `userId`, else null. */
function ownData(doc, userId) {
  const data = doc?.data;
  return data && String(data.userId) === String(userId) ? data : null;
}

/** Entries of a document, an empty list when it has none. */
function entriesOf(data) {
  return Array.isArray(data?.aiAcknowledgements) ? data.aiAcknowledgements : [];
}

/** Whether an entry was confirmed before `resetAt` ("Remove all"). */
function isBefore(entry, resetAt) {
  const reset = Date.parse(resetAt);
  return Number.isFinite(reset) && Date.parse(entry?.acknowledgedAt) < reset;
}

/**
 * Per-user AI acknowledgements on top of the storage abstraction.
 */
export class AiAcknowledgementRepository {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.documents] - Document facet; null makes every method a no-op
   * @param {Object} [options.logger]
   */
  constructor({ documents = null, logger: log } = {}) {
    this.documents = documents || null;
    this.logger = log || logger;
  }

  /** Whether this repository can store anything. */
  isAvailable() {
    return Boolean(this.documents);
  }

  /**
   * One user's document, or null when they have none.
   *
   * @param {string} userId
   * @returns {Promise<{userId: string, aiAcknowledgements?: Object[], aiAcknowledgementsClearedAt?: string}|null>}
   */
  async get(userId) {
    if (!this.isAvailable() || !userId) return null;
    return ownData(
      await this.documents.get(AI_ACKNOWLEDGEMENTS_NAMESPACE, acknowledgementKey(userId)),
      userId
    );
  }

  /**
   * Read, change and write one user's document under compare-and-set.
   *
   * @param {string} userId
   * @param {(current: Object) => {next: Object|null, result: *}} mutate - `next`
   *   null writes nothing
   * @returns {Promise<*>} The `result` of the run that won
   */
  async _update(userId, mutate) {
    const key = acknowledgementKey(userId);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const doc = await this.documents.get(AI_ACKNOWLEDGEMENTS_NAMESPACE, key);
      const current = ownData(doc, userId) || {
        version: AI_ACKNOWLEDGEMENT_DOC_VERSION,
        userId: String(userId),
        aiAcknowledgements: []
      };
      const { next, result } = mutate(structuredClone(current));
      if (!next) return result;
      try {
        await this.documents.put(AI_ACKNOWLEDGEMENTS_NAMESPACE, key, next, {
          ownerId: String(userId),
          etag: doc ? doc.etag : null
        });
        return result;
      } catch (error) {
        if (error?.code !== 'ETAG_MISMATCH' || attempt === MAX_ATTEMPTS) throw error;
      }
    }
    throw new StorageError('AI acknowledgement write lost every compare-and-set attempt', {
      code: 'ETAG_MISMATCH'
    });
  }

  /**
   * Record a confirmation. One entry per version: a repeat at a version the
   * user already confirmed (and that still counts) changes nothing. Entries
   * from before `resetAt` are dropped on the way, so "Remove all" also ends
   * here for a user who confirms again.
   *
   * @param {string} userId
   * @param {{version: number, textHash: string, acknowledgedAt: string, language?: string, client?: string}} entry
   * @param {Object} [options]
   * @param {string|null} [options.resetAt] - `aiAcknowledgement.resetAt` of the platform
   * @returns {Promise<{recorded: boolean, entry: Object|null}>} `entry` is null
   *   when nothing can be stored (no storage)
   */
  async record(userId, entry, { resetAt = null } = {}) {
    if (!this.isAvailable() || !userId) return { recorded: false, entry: null };
    return this._update(userId, current => {
      const kept = entriesOf(current).filter(item => !isBefore(item, resetAt));
      const same = kept.find(item => item?.version === entry.version);
      if (same) return { next: null, result: { recorded: false, entry: same } };
      return {
        next: { ...current, aiAcknowledgements: [...kept, entry] },
        result: { recorded: true, entry }
      };
    });
  }

  /**
   * Remove one user's confirmations and stamp `aiAcknowledgementsClearedAt`,
   * which revokes a signed `ihubAiAck` cookie issued before it.
   *
   * @param {string} userId
   * @param {Object} [options]
   * @param {string} [options.now] - ISO time, for tests
   * @returns {Promise<{entries: number}>} How many entries went
   */
  async clear(userId, { now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !userId) return { entries: 0 };
    const result = await this._update(userId, current => ({
      next: { ...current, aiAcknowledgements: [], aiAcknowledgementsClearedAt: now },
      result: { entries: entriesOf(current).length }
    }));
    forgetAcknowledgement(userId);
    return result;
  }

  /**
   * Every document of the namespace, by user id. One listing (pages of
   * {@link PAGE_SIZE}), never one read per user.
   *
   * @returns {Promise<Map<string, {data: Object, key: string, etag: string}>>}
   */
  async listAll() {
    const all = new Map();
    if (!this.isAvailable()) return all;
    let cursor;
    do {
      const page = await this.documents.list(AI_ACKNOWLEDGEMENTS_NAMESPACE, {
        cursor,
        limit: PAGE_SIZE,
        includeData: true
      });
      for (const doc of page.items) {
        const userId = doc.data?.userId;
        if (typeof userId === 'string' && doc.key === acknowledgementKey(userId)) {
          all.set(userId, { data: doc.data, key: doc.key, etag: doc.etag });
        }
      }
      cursor = page.nextCursor || undefined;
    } while (cursor);
    return all;
  }

  /**
   * After "Remove all": count the entries from before `resetAt` and return
   * what removing them takes. Reading and writing are apart so the admin
   * request answers after the read; {@link prune} does the writes.
   *
   * @param {string} resetAt - ISO time of the reset
   * @returns {Promise<{users: number, entries: number, stale: Array<{key: string, etag: string, data: Object}>}>}
   */
  async collectBefore(resetAt) {
    const stale = [];
    let entries = 0;
    for (const { data, key, etag } of (await this.listAll()).values()) {
      const all = entriesOf(data);
      const kept = all.filter(item => !isBefore(item, resetAt));
      if (kept.length === all.length) continue;
      entries += all.length - kept.length;
      stale.push({ key, etag, data: { ...data, aiAcknowledgements: kept } });
    }
    return { users: stale.length, entries, stale };
  }

  /**
   * Write what {@link collectBefore} found. A document changed since (the user
   * confirmed again, which drops old entries itself, or an admin removed theirs)
   * is left as it is.
   *
   * @param {Array<{key: string, etag: string, data: Object}>} stale
   * @returns {Promise<number>} Documents rewritten
   */
  async prune(stale) {
    let written = 0;
    for (const { key, etag, data } of stale) {
      try {
        await this.documents.put(AI_ACKNOWLEDGEMENTS_NAMESPACE, key, data, { etag });
        written += 1;
      } catch (error) {
        if (error?.code !== 'ETAG_MISMATCH') throw error;
      }
    }
    return written;
  }

  /**
   * Remove one user's document (user deletion).
   *
   * @param {string} userId
   * @returns {Promise<boolean>} Whether a document was removed
   */
  async delete(userId) {
    if (!this.isAvailable() || !userId) return false;
    const removed = await this.documents.delete(
      AI_ACKNOWLEDGEMENTS_NAMESPACE,
      acknowledgementKey(userId)
    );
    forgetAcknowledgement(userId);
    return removed;
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the bootstrapped storage provider.
 *
 * @returns {AiAcknowledgementRepository}
 */
export function getAiAcknowledgementRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new AiAcknowledgementRepository({
      documents: readFacet(provider, 'documents'),
      logger
    });
  }
  return cachedRepository;
}

export default AiAcknowledgementRepository;
