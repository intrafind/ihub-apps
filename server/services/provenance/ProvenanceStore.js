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

/** Compare-and-set attempts before a write gives up. */
const CAS_ATTEMPTS = 4;

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
  }

  /** Whether the store can read and write. */
  isAvailable() {
    return Boolean(this.documents);
  }

  /**
   * Store a record under its content hash (and under each of `extraHashes`,
   * e.g. the final-step text of a multi-step turn). Newest first, capped.
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
    for (const key of keys) await this._prepend(key, record);
    return true;
  }

  async _prepend(hash, record) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.documents.get(PROVENANCE_RECORDS_NAMESPACE, hash);
      const current = Array.isArray(existing?.data?.records) ? existing.data.records : [];
      const records = [record, ...current.filter(r => r.output_id !== record.output_id)].slice(
        0,
        MAX_RECORDS_PER_HASH
      );
      try {
        await this.documents.put(
          PROVENANCE_RECORDS_NAMESPACE,
          hash,
          { v: DOCUMENT_VERSION, records },
          { etag: existing ? existing.etag : null }
        );
        return;
      } catch (error) {
        if (!(error instanceof EtagMismatchError) || attempt === CAS_ATTEMPTS - 1) throw error;
      }
    }
  }

  /**
   * The records stored for a content hash, newest first.
   *
   * @param {string} hash - Lowercase hex SHA-256.
   * @returns {Promise<Object[]>}
   */
  async findByHash(hash) {
    if (!this.isAvailable() || !isHexHash(hash)) return [];
    const doc = await this.documents.get(PROVENANCE_RECORDS_NAMESPACE, hash);
    return Array.isArray(doc?.data?.records) ? doc.data.records : [];
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

  /**
   * Drop the `user` member of every record that names one of `ids` (a deleted
   * user's id and fingerprint). The records themselves stay: they describe an
   * output, not the person.
   *
   * @param {string[]} ids
   * @returns {Promise<{scanned: number, changedRecords: number}>}
   */
  async forgetUser(ids) {
    const result = { scanned: 0, changedRecords: 0 };
    const wanted = new Set((ids || []).filter(Boolean).map(String));
    if (!this.isAvailable() || wanted.size === 0) return result;
    await this._eachDocument(async doc => {
      result.scanned += 1;
      const records = Array.isArray(doc.data?.records) ? doc.data.records : [];
      let changed = 0;
      const next = records.map(r => {
        if (!r?.user || !wanted.has(String(r.user.id))) return r;
        changed += 1;
        const { user: _user, ...rest } = r;
        return rest;
      });
      if (changed === 0) return;
      try {
        await this.documents.put(
          PROVENANCE_RECORDS_NAMESPACE,
          doc.key,
          { v: DOCUMENT_VERSION, records: next },
          { etag: doc.etag }
        );
        result.changedRecords += changed;
      } catch (error) {
        // Written again since the scan (a new record prepended): read it once more.
        if (!(error instanceof EtagMismatchError)) throw error;
        const fresh = await this.documents.get(PROVENANCE_RECORDS_NAMESPACE, doc.key);
        if (fresh) await this.forgetUserIn({ ...fresh, key: doc.key }, wanted, result);
      }
    });
    return result;
  }

  /** One retry of {@link forgetUser} on a document that changed under it. */
  async forgetUserIn(doc, wanted, result) {
    const records = Array.isArray(doc.data?.records) ? doc.data.records : [];
    const next = records.map(r => {
      if (!r?.user || !wanted.has(String(r.user.id))) return r;
      result.changedRecords += 1;
      const { user: _user, ...rest } = r;
      return rest;
    });
    await this.documents.put(
      PROVENANCE_RECORDS_NAMESPACE,
      doc.key,
      { v: DOCUMENT_VERSION, records: next },
      { etag: doc.etag }
    );
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
