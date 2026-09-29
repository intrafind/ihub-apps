/**
 * Detection log (CoP 2.1.3): metadata of every verification — time,
 * requester, content hash, kind, verdict, techniques. **Never the submitted
 * content.** Retention is set by `aiTransparency.detection.log.retentionDays`.
 *
 * Entries live in the `provenance-detections` runtime namespace, keyed by a
 * sortable time-based id, so a listing is newest-last without an index.
 *
 * @module services/provenance/detection/DetectionLog
 */
import crypto from 'node:crypto';
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../../storage/namespaces.js';
import logger from '../../../utils/logger.js';
import { getAiTransparencyConfig } from '../config.js';

export const DETECTION_LOG_NAMESPACE = RUNTIME_NAMESPACES.provenanceDetections;
const MEMORY_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function entryId(at) {
  return `${at.replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

class DetectionLog {
  constructor() {
    this.memory = [];
    this._documents = undefined;
  }

  _setDocuments(documents) {
    this._documents = documents;
  }

  _docs() {
    if (this._documents !== undefined) return this._documents;
    return readFacet(getStorage(), 'documents');
  }

  /**
   * Record one verification (metadata only).
   * @param {Object} entry
   * @param {{type: string, id?: string}} entry.requester
   * @param {string} entry.contentHash
   * @param {string} entry.kind
   * @param {string} [entry.mimeType]
   * @param {number} [entry.size]
   * @param {string} entry.verdict
   * @param {string[]} entry.techniques - techniques that found a mark
   * @param {number} [entry.durationMs]
   */
  async add(entry) {
    const cfg = getAiTransparencyConfig();
    if (!cfg.detection.log.enabled) return null;
    const at = new Date().toISOString();
    const record = {
      id: entryId(at),
      at,
      requester: entry.requester,
      contentHash: entry.contentHash,
      kind: entry.kind,
      mimeType: entry.mimeType || null,
      size: entry.size ?? null,
      verdict: entry.verdict,
      techniques: entry.techniques || [],
      durationMs: entry.durationMs ?? null
    };
    this.memory.push(record);
    if (this.memory.length > MEMORY_LIMIT) this.memory.shift();
    const documents = this._docs();
    if (documents) {
      try {
        await documents.put(DETECTION_LOG_NAMESPACE, record.id, record, { ownerId: 'system' });
      } catch (error) {
        logger.warn('Detection log write failed', {
          component: 'DetectionLog',
          error: error.message
        });
      }
    }
    return record;
  }

  /**
   * The latest entries, newest first.
   * @param {{limit?: number}} [opts]
   */
  async list({ limit = 100 } = {}) {
    const documents = this._docs();
    if (documents?.scan) {
      try {
        const all = [];
        for await (const doc of documents.scan(DETECTION_LOG_NAMESPACE)) {
          if (doc.data) all.push(doc.data);
          if (all.length > limit) all.shift();
        }
        return all.reverse();
      } catch (error) {
        logger.warn('Detection log read failed', {
          component: 'DetectionLog',
          error: error.message
        });
      }
    }
    return [...this.memory].slice(-limit).reverse();
  }

  /** Delete entries older than the retention period. */
  async sweep(retentionDays) {
    const days = retentionDays ?? getAiTransparencyConfig().detection.log.retentionDays;
    if (!(days > 0)) return 0;
    const cutoff = Date.now() - days * DAY_MS;
    this.memory = this.memory.filter(e => Date.parse(e.at) >= cutoff);
    const documents = this._docs();
    if (!documents?.scan) return 0;
    let deleted = 0;
    try {
      for await (const doc of documents.scan(DETECTION_LOG_NAMESPACE)) {
        if (doc.data?.at && Date.parse(doc.data.at) < cutoff) {
          await documents.delete(DETECTION_LOG_NAMESPACE, doc.key);
          deleted++;
        }
      }
    } catch (error) {
      logger.warn('Detection log sweep failed', {
        component: 'DetectionLog',
        error: error.message
      });
    }
    return deleted;
  }
}

const detectionLog = new DetectionLog();
export default detectionLog;
