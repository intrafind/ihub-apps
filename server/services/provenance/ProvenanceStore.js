// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProvenanceStore — the record store behind "did this exact output come from
 * this installation?".
 *
 * One document per content hash. The key is the lowercase hex SHA-256, the body
 * is `{ v: 1, records: [...] }`, newest first, capped at {@link MAX_RECORDS_PER_HASH}
 * (the same text answered many times, e.g. "Yes", must not grow a document
 * without bound). A lookup is one `get`; no scan.
 *
 * **The store never holds output text** — only the provenance object: hash, time, model, generator, marking status and
 * the output id. Records are keyed by hash alone, so text (`nfc-trim`) and
 * media bytes (`none`, #3328) share one store; the record's own
 * `content_hash.normalization` says how the hash was made.
 *
 * Retention: {@link ProvenanceStore#sweep} drops records older than a cutoff
 * and deletes a document whose last record went. Known limit: the filesystem
 * provider keeps a flat directory per namespace, comfortable to roughly 1-2M
 * records; a database provider answers both queries natively.
 *
 * @module services/provenance/ProvenanceStore
 */
import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { EtagMismatchError } from '../../storage/errors.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { isHexHash } from './records.js';

export const PROVENANCE_RECORDS_NAMESPACE = RUNTIME_NAMESPACES.provenanceRecords;
export const PROVENANCE_META_NAMESPACE = RUNTIME_NAMESPACES.provenanceMeta;

/** Records kept per content hash. */
export const MAX_RECORDS_PER_HASH = 20;

/**
 * Compare-and-set attempts before a write gives up. Writers of one hash that
 * read the same etag lose one by one (only one put wins a round), so the
 * budget covers a burst of concurrent writers, with a short jittered pause
 * between attempts so the retries do not collide again.
 */
const CAS_ATTEMPTS = 16;
const CAS_RETRY_MS = 5;

/** Pause before a failed flush of a hash is tried again. */
const FLUSH_RETRY_MS = 1000;

/**
 * Failed flushes of one hash in a row before its pending records are dropped:
 * with storage down, memory stays bounded (at most {@link MAX_RECORDS_PER_HASH}
 * records per hash, for a few seconds).
 */
const FLUSH_ATTEMPTS = 5;

const DOCUMENT_VERSION = 1;

/** Documents per page when the provider cannot scan. */
const LIST_PAGE_SIZE = 500;

/** The fields a stored record may carry; a test asserts nothing else is written. */
export const ALLOWED_RECORD_KEYS = Object.freeze([
  'spec',
  'ai_generated',
  'generator',
  'model',
  'output_id',
  'created_at',
  'kind',
  'content_hash',
  // Media records (#3328): what the provider embedded.
  'provider_marking',
  // Who produced it, when `provenance.recordUser` asks for it (provenanceUser.js).
  'user'
]);

/**
 * `batch` (oldest first) prepended to `current` (newest first): newest first,
 * one record per output id, capped at {@link MAX_RECORDS_PER_HASH}.
 */
function prependAll(batch, current) {
  const seen = new Set();
  return [...[...batch].reverse(), ...current]
    .filter(r => !seen.has(r.output_id) && seen.add(r.output_id))
    .slice(0, MAX_RECORDS_PER_HASH);
}

function createdAtMs(record) {
  const parsed = Date.parse(record?.created_at);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Keep only the allowed top-level fields of a record. A guard rather than a
 * feature: a caller that passes more (a text by mistake) cannot reach disk.
 */
function sanitizeRecord(provenance) {
  const record = provenance || {};
  const clean = {};
  for (const key of ALLOWED_RECORD_KEYS) {
    if (record[key] !== undefined) clean[key] = record[key];
  }
  return clean;
}

export class ProvenanceStore {
  /**
   * @param {Object} [options]
   * @param {Object} [options.documents] - Document facet.
   * @param {Object} [options.log]
   */
  constructor({ documents = null, log = logger } = {}) {
    this.documents = documents || null;
    this.log = log;
    this._installationId = null;
    /**
     * Per hash, the records not yet written (`pending`, oldest first), the
     * batch being written (`writing`), the flush running and its retry timer.
     * @type {Map<string, Object>}
     */
    this._queues = new Map();
  }

  /** Whether the store can read and write. */
  isAvailable() {
    return Boolean(this.documents);
  }

  /**
   * Store a record under its content hash (and under each of `extraHashes`,
   * e.g. the final-step text of a multi-step turn). Newest first, capped.
   *
   * Writes are coalesced per hash: the records of one process that arrive while
   * a hash is being written wait in memory and go out together in the next
   * flush, one compare-and-set loop for all of them. Without it, many turns
   * producing the same text (a template, a short standard answer) each ran
   * their own loop against one document and lost most rounds. The call
   * resolves once a flush that includes the record has been tried; a failed
   * flush is logged and retried after {@link FLUSH_RETRY_MS}, so the call never
   * rejects for a write failure. {@link ProvenanceStore#findByHash} sees
   * pending records at once.
   *
   * @param {Object} provenance - Provenance object with `content_hash`.
   * @param {Object} [options]
   * @param {string[]} [options.extraHashes] - More index keys for the same record.
   * @returns {Promise<boolean>} False when there was nothing to store.
   */
  async record(provenance, { extraHashes = [] } = {}) {
    if (!this.isAvailable()) return false;
    const record = sanitizeRecord(provenance);
    const primary = record.content_hash?.value;
    if (!isHexHash(primary)) return false;
    const keys = [...new Set([primary, ...extraHashes.filter(isHexHash)])];
    // Queued synchronously (before the first await), so a reader right after
    // an unawaited call already sees the record.
    await Promise.all(keys.map(key => this._enqueue(key, record)));
    return true;
  }

  /**
   * Write every pending record now (shutdown). A record still pending when the
   * process exits without this is lost: at most the last flush's worth.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await Promise.all(
      [...this._queues].map(([hash, queue]) => {
        clearTimeout(queue.retry);
        queue.retry = null;
        return this._startFlush(hash, queue);
      })
    );
  }

  /** Same shape as ChatFileRepository#_adjustServerBytes: a ticket per record. */
  async _enqueue(hash, record) {
    let queue = this._queues.get(hash);
    if (!queue) {
      queue = { pending: [], writing: null, ticket: 0, flush: null, retry: null, failures: 0 };
      this._queues.set(hash, queue);
    }
    queue.pending.push(record);
    // Older ones would be trimmed from the document anyway.
    if (queue.pending.length > MAX_RECORDS_PER_HASH) {
      queue.pending.splice(0, queue.pending.length - MAX_RECORDS_PER_HASH);
    }
    queue.ticket += 1;
    const ticket = queue.ticket;
    // A flush already running took its batch before this record: wait for it,
    // then start (or join) the next one.
    while ((await this._startFlush(hash, queue)) < ticket);
  }

  /** The running flush of a hash, or a new one. Never rejects. */
  _startFlush(hash, queue) {
    queue.flush ??= this._flush(hash, queue).finally(() => {
      queue.flush = null;
      if (!queue.pending.length && !queue.retry) this._queues.delete(hash);
    });
    return queue.flush;
  }

  /**
   * Write the pending batch of a hash. On failure the batch goes back to the
   * front of the queue and a retry is scheduled; after {@link FLUSH_ATTEMPTS}
   * failures in a row it is dropped.
   *
   * @returns {Promise<number>} The last ticket this flush took.
   */
  async _flush(hash, queue) {
    const ticket = queue.ticket;
    const batch = queue.pending.splice(0);
    if (!batch.length) return ticket;
    queue.writing = batch;
    try {
      await this._prepend(hash, batch);
      queue.failures = 0;
    } catch (error) {
      queue.failures += 1;
      if (queue.failures >= FLUSH_ATTEMPTS) {
        queue.failures = 0;
        this.log.warn('Provenance records dropped after repeated write failures', {
          component: 'ProvenanceStore',
          records: batch.length,
          error: error.message
        });
      } else {
        queue.pending = [...batch, ...queue.pending].slice(-MAX_RECORDS_PER_HASH);
        this.log.warn('Could not store provenance records; retrying', {
          component: 'ProvenanceStore',
          records: batch.length,
          error: error.message
        });
        queue.retry ??= setTimeout(() => {
          queue.retry = null;
          this._startFlush(hash, queue);
        }, FLUSH_RETRY_MS);
        queue.retry.unref?.();
      }
    } finally {
      queue.writing = null;
    }
    return ticket;
  }

  /** Prepend `batch` (oldest first) to the hash document, compare-and-set. */
  async _prepend(hash, batch) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.documents.get(PROVENANCE_RECORDS_NAMESPACE, hash);
      const current = Array.isArray(existing?.data?.records) ? existing.data.records : [];
      try {
        await this.documents.put(
          PROVENANCE_RECORDS_NAMESPACE,
          hash,
          { v: DOCUMENT_VERSION, records: prependAll(batch, current) },
          { etag: existing ? existing.etag : null }
        );
        return;
      } catch (error) {
        if (!(error instanceof EtagMismatchError) || attempt === CAS_ATTEMPTS - 1) throw error;
        await new Promise(resolve =>
          setTimeout(resolve, CAS_RETRY_MS * (1 + Math.random()) * Math.min(attempt + 1, 4))
        );
      }
    }
  }

  /**
   * The records stored for a content hash, newest first, with the ones this
   * process has not written yet in front.
   *
   * @param {string} hash - Lowercase hex SHA-256.
   * @returns {Promise<Object[]>}
   */
  async findByHash(hash) {
    if (!this.isAvailable() || !isHexHash(hash)) return [];
    const doc = await this.documents.get(PROVENANCE_RECORDS_NAMESPACE, hash);
    const stored = Array.isArray(doc?.data?.records) ? doc.data.records : [];
    const queue = this._queues.get(hash);
    if (!queue) return stored;
    return prependAll([...(queue.writing || []), ...queue.pending], stored);
  }

  /**
   * Remove records created before `cutoffMs`.
   *
   * A hash re-recorded exactly while its last record is being swept can lose
   * that one record; acceptable for a retention sweep.
   *
   * @param {number} cutoffMs - Epoch milliseconds.
   * @returns {Promise<{scanned: number, removedRecords: number, removedDocuments: number}>}
   */
  async sweep(cutoffMs) {
    const result = { scanned: 0, removedRecords: 0, removedDocuments: 0 };
    if (!this.isAvailable()) return result;
    const handle = async doc => {
      result.scanned += 1;
      const records = Array.isArray(doc.data?.records) ? doc.data.records : [];
      const kept = records.filter(r => {
        const at = createdAtMs(r);
        return !(Number.isFinite(at) && at < cutoffMs);
      });
      if (kept.length === records.length) return;
      result.removedRecords += records.length - kept.length;
      try {
        if (kept.length === 0) {
          await this.documents.delete(PROVENANCE_RECORDS_NAMESPACE, doc.key);
          result.removedDocuments += 1;
        } else {
          await this.documents.put(
            PROVENANCE_RECORDS_NAMESPACE,
            doc.key,
            { v: DOCUMENT_VERSION, records: kept },
            { etag: doc.etag }
          );
        }
      } catch (error) {
        // Written again since the scan: the next sweep judges it afresh.
        if (!(error instanceof EtagMismatchError)) throw error;
      }
    };
    await this._eachDocument(handle);
    return result;
  }

  /** Visit every record document (scan when the provider can, else pages). */
  async _eachDocument(handle) {
    if (this.documents.supportsScan) {
      for await (const doc of this.documents.scan(PROVENANCE_RECORDS_NAMESPACE)) await handle(doc);
      return;
    }
    let cursor;
    do {
      const page = await this.documents.list(PROVENANCE_RECORDS_NAMESPACE, {
        limit: LIST_PAGE_SIZE,
        cursor,
        includeData: true
      });
      for (const doc of page.items) await handle(doc);
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * The installation id: `IHUB_INSTALLATION_ID` when the operator manages
   * identity, else a random opaque id minted once (create-only write, so two
   * workers never mint two). Not derived from hostname, licence or hardware.
   * Copying `contents/` to a staging system copies the id.
   *
   * @returns {Promise<string>}
   */
  async installationId() {
    const fromEnv = process.env.IHUB_INSTALLATION_ID?.trim();
    if (fromEnv) return fromEnv;
    if (this._installationId) return this._installationId;
    if (!this.isAvailable()) return 'inst_unavailable';
    const read = async () =>
      (await this.documents.get(PROVENANCE_META_NAMESPACE, 'installation'))?.data?.id;
    let id = await read();
    if (!id) {
      try {
        const minted = `inst_${randomUUID()}`;
        await this.documents.put(
          PROVENANCE_META_NAMESPACE,
          'installation',
          { id: minted },
          { etag: null }
        );
        id = minted;
      } catch (error) {
        if (!(error instanceof EtagMismatchError)) throw error;
        id = await read();
      }
    }
    this._installationId = id;
    return id;
  }
}

let cachedStore = null;
let cachedProvider = null;

/**
 * The process-wide store over the bootstrapped storage provider.
 *
 * @returns {ProvenanceStore}
 */
export function getProvenanceStore() {
  const provider = getStorage();
  if (!cachedStore || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedStore = new ProvenanceStore({ documents: readFacet(provider, 'documents') });
  }
  return cachedStore;
}

export default ProvenanceStore;
