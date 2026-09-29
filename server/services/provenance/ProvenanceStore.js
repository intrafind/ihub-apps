/**
 * Per-output provenance records (concept §8.1 hook 2, §8.3; issue #2570).
 *
 * For every assistant message, API completion, MCP/A2A result and generated
 * image iHub keeps a small record: content hash, model, time, marking status
 * and a random content id. **Never the content.** The server needs it to
 * vouch for content a client sends back (exports of unstored chats, the
 * detector's "was this produced here?" lookup), and it works whether chat
 * persistence is on or off.
 *
 * Records live in the `provenance-records` runtime namespace (keyed by
 * content id) with a `provenance-hashes` index (content hash → content id).
 * Retention is deployer-controlled (`aiTransparency.provenance.retentionDays`,
 * CoP 1.1.3); a daily sweep deletes older records. Without a storage provider
 * records are kept in a bounded in-memory map for this process only.
 *
 * @module services/provenance/ProvenanceStore
 */
import crypto from 'node:crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import logger from '../../utils/logger.js';
import { getAiTransparencyConfig, isAiTransparencyActive } from './config.js';
import { getInstallationId } from './installation.js';
import { evaluateTextMarking } from './markingPolicy.js';

const COMPONENT = 'ProvenanceStore';
export const PROVENANCE_RECORDS_NAMESPACE = RUNTIME_NAMESPACES.provenanceRecords;
export const PROVENANCE_HASHES_NAMESPACE = RUNTIME_NAMESPACES.provenanceHashes;
const MEMORY_LIMIT = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Invisible characters the text signpost adds; stripped before hashing so a
// signposted copy hashes like the original.
const SIGNPOST_CHARS_RE = /[﻿︀-️]|\uDB40[\uDD00-\uDDEF]/g;

/**
 * Normalise text for hashing: NFC, LF line ends, no signpost characters,
 * no trailing whitespace per line, trimmed.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForHash(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(SIGNPOST_CHARS_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * `sha256:<hex>` of normalised text.
 * @param {string} text
 */
export function hashContent(text) {
  return `sha256:${crypto.createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex')}`;
}

/** `sha256:<hex>` of raw bytes. */
export function hashBytes(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

/** A random, non-identifying content id (no user data, concept §6 item 7). */
export function newContentId() {
  return `prv_${crypto.randomBytes(12).toString('base64url')}`;
}

function hashKey(contentHash) {
  return String(contentHash).replace(/^sha256:/, '');
}

/**
 * What callers and clients see of a record.
 * @param {Object} record
 */
export function publicProvenance(record) {
  if (!record) return null;
  return {
    contentId: record.contentId,
    contentHash: record.contentHash,
    aiGenerated: true,
    generatedAt: record.generatedAt,
    generator: record.generator,
    model: record.model,
    kind: record.kind,
    marking: record.text
      ? {
          status: record.text.status,
          technique: record.text.technique,
          required: record.text.required,
          tokens: record.text.tokens,
          reason: record.text.reason || undefined
        }
      : undefined,
    images: record.images?.length ? record.images : undefined,
    conforming: record.conforming
  };
}

class ProvenanceStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this.memory = new Map();
    /** @type {Map<string, string>} */
    this.memoryHashes = new Map();
    this._documents = undefined;
    this._sweepTimer = null;
  }

  /** Test hook: pin a DocumentStore (or null for memory only). */
  _setDocuments(documents) {
    this._documents = documents;
  }

  _docs() {
    if (this._documents !== undefined) return this._documents;
    return readFacet(getStorage(), 'documents');
  }

  _remember(record) {
    this.memory.set(record.contentId, record);
    this.memoryHashes.set(hashKey(record.contentHash), record.contentId);
    while (this.memory.size > MEMORY_LIMIT) {
      const [oldestId, oldest] = this.memory.entries().next().value;
      this.memory.delete(oldestId);
      this.memoryHashes.delete(hashKey(oldest.contentHash));
    }
  }

  async _put(record) {
    this._remember(record);
    const documents = this._docs();
    if (!documents) return;
    try {
      await documents.put(PROVENANCE_RECORDS_NAMESPACE, record.contentId, record, {
        ownerId: 'system'
      });
      await documents.put(
        PROVENANCE_HASHES_NAMESPACE,
        hashKey(record.contentHash),
        { contentId: record.contentId, createdAt: record.generatedAt },
        { ownerId: 'system' }
      );
    } catch (error) {
      logger.warn('Provenance record write failed; kept in memory only', {
        component: COMPONENT,
        error: error.message
      });
    }
  }

  /**
   * Record a generated text output (and the images it carried).
   *
   * @param {Object} params
   * @param {string} params.content - final text (hashed, not stored)
   * @param {'chat'|'inference'|'mcp'|'a2a'|'workflow'|'export'} params.kind
   * @param {Object|null} params.model - model config
   * @param {Object|null} [params.app]
   * @param {number|null} [params.temperature]
   * @param {Object[]} [params.images] - image provenance from the image marker
   * @returns {Promise<Object|null>} the public provenance, or null when disabled
   */
  async recordText({ content, kind, model, app = null, temperature = null, images = [] }) {
    if (!isAiTransparencyActive()) return null;
    const cfg = getAiTransparencyConfig();
    if (!cfg.provenance.enabled) return null;
    const text = typeof content === 'string' ? content : '';
    if (!text.trim() && images.length === 0) return null;
    const textMarking = text.trim()
      ? evaluateTextMarking({ content: text, model, app, temperature, cfg })
      : null;
    const record = {
      v: 1,
      contentId: newContentId(),
      contentHash: hashContent(text),
      kind,
      generatedAt: new Date().toISOString(),
      generator: { name: 'iHub Apps', version: getAppVersion() },
      installationId: getInstallationId(),
      model: model ? { id: model.id, provider: model.provider } : null,
      appId: app?.id || null,
      text: textMarking,
      images: images.map(i => ({
        contentId: i.contentId,
        sha256: i.sha256,
        mimeType: i.mimeType,
        markings: i.markings
      })),
      conforming:
        (textMarking ? textMarking.conforming : true) && images.every(i => i.conforming !== false)
    };
    await this._put(record);
    return publicProvenance(record);
  }

  /**
   * Record a generated image (called by the image marker after signing).
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async recordImage({ contentId, sha256, mimeType, model, markings, conforming }) {
    const record = {
      v: 1,
      contentId,
      contentHash: sha256,
      kind: 'image',
      generatedAt: new Date().toISOString(),
      generator: { name: 'iHub Apps', version: getAppVersion() },
      installationId: getInstallationId(),
      model: model ? { id: model.id, provider: model.provider } : null,
      appId: null,
      text: null,
      images: [],
      mimeType,
      markings,
      conforming
    };
    const cfg = getAiTransparencyConfig();
    if (isAiTransparencyActive() && cfg.provenance.enabled) await this._put(record);
    return record;
  }

  /**
   * A record by content id.
   * @param {string} contentId
   */
  async get(contentId) {
    if (typeof contentId !== 'string' || !/^prv_[A-Za-z0-9_-]{8,40}$/.test(contentId)) return null;
    const documents = this._docs();
    if (documents) {
      try {
        const doc = await documents.get(PROVENANCE_RECORDS_NAMESPACE, contentId);
        if (doc?.data) return doc.data;
      } catch (error) {
        logger.warn('Provenance record read failed', {
          component: COMPONENT,
          error: error.message
        });
      }
    }
    return this.memory.get(contentId) || null;
  }

  /**
   * A record by content hash (`sha256:<hex>`).
   * @param {string} contentHash
   */
  async findByHash(contentHash) {
    const key = hashKey(contentHash);
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const documents = this._docs();
    if (documents) {
      try {
        const doc = await documents.get(PROVENANCE_HASHES_NAMESPACE, key);
        if (doc?.data?.contentId) return this.get(doc.data.contentId);
      } catch (error) {
        logger.warn('Provenance hash lookup failed', {
          component: COMPONENT,
          error: error.message
        });
      }
    }
    const id = this.memoryHashes.get(key);
    return id ? this.memory.get(id) || null : null;
  }

  /**
   * The record of exactly this text, if iHub generated it.
   * @param {string} text
   */
  async findByContent(text) {
    return this.findByHash(hashContent(text));
  }

  /**
   * Delete records older than the retention period.
   * @param {number} [retentionDays]
   * @returns {Promise<number>} records deleted
   */
  async sweep(retentionDays) {
    const days = retentionDays ?? getAiTransparencyConfig().provenance.retentionDays;
    if (!(days > 0)) return 0;
    const cutoff = Date.now() - days * DAY_MS;
    let deleted = 0;
    for (const [id, record] of this.memory) {
      if (Date.parse(record.generatedAt) < cutoff) {
        this.memory.delete(id);
        this.memoryHashes.delete(hashKey(record.contentHash));
      }
    }
    const documents = this._docs();
    if (!documents?.scan) return deleted;
    try {
      for await (const doc of documents.scan(PROVENANCE_RECORDS_NAMESPACE)) {
        const record = doc.data;
        if (!record?.generatedAt || Date.parse(record.generatedAt) >= cutoff) continue;
        await documents.delete(PROVENANCE_RECORDS_NAMESPACE, doc.key);
        if (record.contentHash) {
          await documents
            .delete(PROVENANCE_HASHES_NAMESPACE, hashKey(record.contentHash))
            .catch(() => {});
        }
        deleted++;
      }
    } catch (error) {
      logger.warn('Provenance retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    }
    if (deleted) logger.info('Provenance retention sweep', { component: COMPONENT, deleted, days });
    return deleted;
  }

  /** Run the sweep daily. */
  startRetentionScheduler() {
    if (this._sweepTimer) return;
    const run = () => this.sweep().catch(() => {});
    setTimeout(run, 60 * 1000).unref?.();
    this._sweepTimer = setInterval(run, DAY_MS);
    this._sweepTimer.unref?.();
  }

  stopRetentionScheduler() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }
}

const provenanceStore = new ProvenanceStore();
export default provenanceStore;
