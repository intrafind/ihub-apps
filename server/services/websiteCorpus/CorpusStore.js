// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where the website corpus sizer keeps what it crawled.
 *
 * One document per corpus (settings, progress, counters), owned by the user who
 * started it, and blobs under the same namespace: the URL list once, and the
 * extracted pages one blob per crawl batch. A batch is written once and never
 * changed, so a crawl of thousands of pages does not re-serialise a growing
 * document on every call (the lesson of the artifact store).
 *
 * A corpus is a working copy for one sizing: it is removed after
 * `RETENTION_DAYS`, a user keeps at most `MAX_CORPORA_PER_USER`, and every read
 * checks the owner, so one user's crawl is never reachable by another.
 *
 * @module services/websiteCorpus/CorpusStore
 */
import { randomUUID } from 'node:crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { isValidId } from '../../utils/pathSecurity.js';

export const CORPUS_NAMESPACE = RUNTIME_NAMESPACES.websiteCorpora;

/** How long a corpus is kept, and how many one user keeps. */
export const RETENTION_DAYS = 14;
export const MAX_CORPORA_PER_USER = 5;

/** A stable error code the connector maps to a message for the model. */
export class CorpusError extends Error {
  /**
   * @param {string} code - STORAGE_UNAVAILABLE | CORPUS_NOT_FOUND
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CorpusError';
    this.code = code;
  }
}

const LOCK_OPTIONS = { ttlMs: 120_000, waitMs: 5_000 };

const pageKeyOf = (id, batch) => `${id}__pages__${String(batch).padStart(5, '0')}`;
const urlsKeyOf = id => `${id}__urls`;

export class CorpusStore {
  /**
   * @param {{documents: Object, blobs: Object, locks: Object}} [facets] - Storage facets; defaults to the active provider's
   */
  constructor({ documents = null, blobs = null, locks = null } = {}) {
    this.documents = documents;
    this.blobs = blobs;
    this.locks = locks;
  }

  isAvailable() {
    return Boolean(this.documents && this.blobs);
  }

  _require() {
    if (!this.isAvailable()) {
      throw new CorpusError(
        'STORAGE_UNAVAILABLE',
        'Crawled pages cannot be kept: the storage provider has no document and blob store'
      );
    }
  }

  /**
   * Create a corpus.
   *
   * @param {string} ownerId
   * @param {Object} corpus - Settings and counters (see the service)
   * @param {string[]} urls - The URLs to crawl, in sitemap order
   * @returns {Promise<Object>} The stored corpus, with its `id`
   */
  async create(ownerId, corpus, urls) {
    this._require();
    const id = `wc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = new Date().toISOString();
    const body = { ...corpus, id, ownerId, createdAt: now, updatedAt: now, batches: 0 };
    await this.blobs.put(CORPUS_NAMESPACE, urlsKeyOf(id), JSON.stringify(urls), {
      contentType: 'application/json'
    });
    await this.documents.put(CORPUS_NAMESPACE, id, body, { ownerId, etag: null });
    return body;
  }

  /**
   * A corpus of the owner.
   *
   * @param {string} id
   * @param {string} ownerId
   * @returns {Promise<Object>}
   * @throws {CorpusError} `CORPUS_NOT_FOUND` for an unknown id and for another user's corpus alike
   */
  async get(id, ownerId) {
    this._require();
    const doc = isValidId(id) ? await this.documents.get(CORPUS_NAMESPACE, id) : null;
    if (!doc?.data || doc.data.ownerId !== ownerId) {
      throw new CorpusError('CORPUS_NOT_FOUND', 'No such corpus. Start with a site discovery.');
    }
    return doc.data;
  }

  /** The URLs of a corpus, in order. */
  async urls(id) {
    const blob = await this.blobs.get(CORPUS_NAMESPACE, urlsKeyOf(id));
    return blob ? JSON.parse(blob.data.toString('utf8')) : [];
  }

  /**
   * Run `fn` while holding the corpus' lock, so two calls of the same crawl
   * never fetch the same pages twice.
   */
  async withCorpus(id, fn) {
    this._require();
    if (!this.locks) return fn();
    return this.locks.withLock(`website-corpus:${id}`, fn, LOCK_OPTIONS);
  }

  /**
   * Save a corpus' progress.
   *
   * @param {Object} corpus - The corpus as read, with the changed counters
   * @returns {Promise<Object>} The corpus as stored
   */
  async save(corpus) {
    this._require();
    const body = { ...corpus, updatedAt: new Date().toISOString() };
    await this.documents.put(CORPUS_NAMESPACE, corpus.id, body, { ownerId: corpus.ownerId });
    return body;
  }

  /**
   * Store one crawl batch.
   *
   * @param {string} id
   * @param {number} batch - The batch number, from 0
   * @param {Array<Object>} pages - `{url, title, date, text, chars, tokens}`
   */
  async putPages(id, batch, pages) {
    await this.blobs.put(CORPUS_NAMESPACE, pageKeyOf(id, batch), JSON.stringify(pages), {
      contentType: 'application/json'
    });
  }

  /** All the pages of a corpus, in crawl order. */
  async pages(id, batches) {
    const pages = [];
    for (let batch = 0; batch < batches; batch++) {
      const blob = await this.blobs.get(CORPUS_NAMESPACE, pageKeyOf(id, batch));
      if (blob) pages.push(...JSON.parse(blob.data.toString('utf8')));
    }
    return pages;
  }

  /** Remove the pages of a corpus (a crawl that starts over), keeping its URL list and settings. */
  async removePages(id) {
    if (!this.isAvailable() || !isValidId(id)) return;
    await this._deleteBlobs(`${id}__pages__`);
  }

  async _deleteBlobs(prefix) {
    let cursor = null;
    do {
      const page = await this.blobs.list(CORPUS_NAMESPACE, { prefix, cursor });
      for (const item of page.items) await this.blobs.delete(CORPUS_NAMESPACE, item.key);
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Remove a corpus and everything stored for it.
   *
   * @param {string} id
   */
  async remove(id) {
    if (!this.isAvailable() || !isValidId(id)) return;
    await this._deleteBlobs(`${id}__`);
    await this.documents.delete(CORPUS_NAMESPACE, id);
  }

  /**
   * Remove the owner's expired corpora, and the oldest ones beyond the limit
   * (counting the one about to be created).
   *
   * @param {string} ownerId
   * @param {number} [now=Date.now()]
   * @returns {Promise<number>} How many were removed
   */
  async prune(ownerId, now = Date.now()) {
    this._require();
    const list = await this.documents.list(CORPUS_NAMESPACE, { ownerId, includeData: true });
    const owned = (list.items || [])
      .filter(doc => doc.data?.ownerId === ownerId)
      .sort((a, b) => Date.parse(a.data.createdAt) - Date.parse(b.data.createdAt));
    const expiry = now - RETENTION_DAYS * 86_400_000;
    const doomed = owned.filter(doc => Date.parse(doc.data.createdAt) < expiry);
    const kept = owned.filter(doc => !doomed.includes(doc));
    doomed.push(...kept.slice(0, Math.max(0, kept.length - (MAX_CORPORA_PER_USER - 1))));
    for (const doc of doomed) await this.remove(doc.key);
    return doomed.length;
  }
}

let defaultStore = null;

/** The store on the active storage provider. */
export function getCorpusStore() {
  const provider = getStorage();
  if (!defaultStore || defaultStore.provider !== provider) {
    defaultStore = new CorpusStore({
      documents: readFacet(provider, 'documents'),
      blobs: readFacet(provider, 'blobs'),
      locks: readFacet(provider, 'locks')
    });
    defaultStore.provider = provider;
  }
  return defaultStore;
}
