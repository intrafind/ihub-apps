/**
 * ArtifactRepository — what a run produced, stored once for every producer.
 *
 * An **artifact** is content a run produced that is worth keeping in its own
 * right: a generated image today, a workflow's report or an agent's output
 * next. It is not a chat concept. A chat turn is one producer among several,
 * so the store is addressed by a **scope** — the thing whose lifetime the
 * artifact follows — rather than by a chat id:
 *
 *   `artifacts/<scopeType>__<scopeId>__<artifactId>`
 *
 * Every artifact of one scope therefore shares a key prefix, which is what
 * makes "everything this chat produced" and "everything this run produced"
 * the same cheap prefix walk, and what lets the delete sweep find an artifact
 * whose descriptor never landed.
 *
 * **The payload is never inlined in the producer's own documents.** A chat
 * transcript and a workflow state document are single documents that their
 * producer re-reads, re-serializes and re-hashes on every step, and ship back
 * whole when the thing is opened. One artifact inlined there is paid for on
 * every step for as long as the producer lives. The producer keeps a
 * descriptor — `{ id, kind, mimeType, bytes }` — and the payload goes
 * somewhere it can be fetched on its own.
 *
 * **Metadata is a document; the payload is a blob.** They are deliberately in
 * different facets. The metadata is small, listable and filterable, and a
 * `list()` must never read a payload to answer. The payload is megabytes
 * written once and read whole, so it goes to the provider's `blobs` facet as
 * raw bytes — no base64 (a 33% tax and a re-encode on every read), no JSON
 * envelope. That is the seam issue #2318 is about: an S3-compatible or
 * database-backed blob store implements four calls and this module does not
 * change, so uploads and artifacts stop pinning a deployment to one volume.
 *
 * **No locking.** An artifact document is written once, read many times and
 * never modified, so there is nothing for two writers to lose. That is also
 * why a write here does not queue behind the producer's own lock.
 *
 * **Authorization is the scope's.** This module has no opinion about who may
 * read an artifact: a route authorizes the chat, the run or the execution
 * that owns it, exactly as it would to read anything else about that scope.
 * An artifact id is minted here and is never a capability on its own.
 *
 * Everything degrades to a no-op when storage is unavailable, like the rest
 * of the runtime stores: a misconfigured provider must cost the picture, not
 * the answer.
 *
 * @module services/artifacts/ArtifactRepository
 */
import { randomUUID } from 'crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { artifactKind, artifactMediaType, artifactPolicy } from './artifactPolicy.js';

const COMPONENT = 'ArtifactRepository';

/**
 * Namespace holding artifacts — one metadata document and one blob per
 * artifact, under the same key in their respective facets.
 */
export const ARTIFACTS_NAMESPACE = RUNTIME_NAMESPACES.artifacts;

/** Schema version stamped on an artifact document. */
export const ARTIFACT_VERSION = 1;

/**
 * Scopes an artifact may belong to — the thing whose lifetime it follows.
 *
 * Closed on purpose: the scope type is part of a storage key, and a typo in
 * one producer would otherwise silently create a scope nothing else can find
 * or sweep.
 *
 * - `chat` — a durable chat; its turns' pictures, swept with the chat.
 * - `run`  — one run of the ledger: a workflow execution, an agent run, or a
 *   chat turn that wants its output kept per run rather than per chat.
 */
export const ARTIFACT_SCOPES = Object.freeze(['chat', 'run']);

/**
 * Separator between the scope, its id and the artifact id in a key.
 *
 * An artifact id never contains the separator, so a scope id that does
 * (`a__b`, whose keys the prefix of scope `a` also matches) is told apart by
 * counting it in the suffix; a read additionally checks the scope recorded
 * inside the document.
 */
const KEY_SEPARATOR = '__';

/** Longest display name stored on an artifact. */
export const MAX_ARTIFACT_NAME_CHARS = 200;

/**
 * Validate a scope, or return null when it cannot address anything.
 *
 * @param {{type: string, id: string}} scope - Scope as a caller passed it.
 * @returns {{type: string, id: string}|null}
 */
export function normalizeScope(scope) {
  const type = scope?.type;
  const id = scope?.id;
  if (!ARTIFACT_SCOPES.includes(type)) return null;
  // The id reaches a storage key. Some scope ids are legal but not storable —
  // a headless agent chat is `agent:<runId>:<hex>`, and a colon is not a valid
  // document key — so such a scope simply has no durable artifacts.
  if (!isValidId(id)) return null;
  return { type, id };
}

/**
 * The document key one artifact is stored under.
 *
 * @param {{type: string, id: string}} scope - Validated scope.
 * @param {string} artifactId - Artifact id.
 * @returns {string} Key in {@link ARTIFACTS_NAMESPACE}.
 */
export function artifactKey(scope, artifactId) {
  return `${scope.type}${KEY_SEPARATOR}${scope.id}${KEY_SEPARATOR}${artifactId}`;
}

/**
 * The key prefix every artifact of one scope shares.
 *
 * @param {{type: string, id: string}} scope - Validated scope.
 * @returns {string} Key prefix.
 */
function scopePrefix(scope) {
  return `${scope.type}${KEY_SEPARATOR}${scope.id}${KEY_SEPARATOR}`;
}

/**
 * Coerce what a producer hands us into the bytes to store.
 *
 * Base64 is accepted because that is how a model reports a generated image,
 * but it is decoded here, at the boundary: the store keeps raw bytes, so the
 * 33% encoding tax is paid once on the way in rather than on disk and again on
 * every read.
 *
 * @param {Buffer|Uint8Array|string} data - Payload, or base64 of one.
 * @returns {Buffer|null} The bytes, or null when there is nothing to store.
 */
function toPayload(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string' && data.length > 0) return Buffer.from(data, 'base64');
  return null;
}

/** Whether two scopes address the same thing. */
function sameScope(a, b) {
  return a?.type === b?.type && a?.id === b?.id;
}

/**
 * The descriptor a producer records, built from a stored document body.
 *
 * @param {string} id - Artifact id.
 * @param {Object} data - Stored document body.
 * @returns {Object} Descriptor without the payload.
 */
function toDescriptor(id, data) {
  const kind = artifactKind(data.kind);
  return {
    id,
    kind,
    mimeType: artifactMediaType(kind, data.mimeType),
    bytes: Number.isFinite(data.bytes) ? data.bytes : 0,
    ...(typeof data.sha256 === 'string' && data.sha256 ? { sha256: data.sha256 } : {}),
    ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
    ...(typeof data.runId === 'string' && data.runId ? { runId: data.runId } : {}),
    ...(typeof data.createdAt === 'string' ? { createdAt: data.createdAt } : {})
  };
}

/**
 * Artifact storage, shared by every producer.
 */
export class ArtifactRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet, for the metadata; null makes every method a no-op.
   * @param {import('../../storage/BlobStore.js').BlobStore|null} [options.blobs]
   *   Blob facet, for the payloads. A provider without one cannot store
   *   artifacts at all — putting megabytes back in documents is exactly what
   *   this split exists to prevent, so it is a no-op rather than a fallback.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   * @param {() => {enabled: boolean, maxBytes: number, maxPerBatch: number}} [options.policy]
   *   Policy source; defaults to the live platform config, and is resolved per
   *   call so an admin's change takes effect without a restart.
   */
  constructor({ documents = null, blobs = null, logger: log, policy = artifactPolicy } = {}) {
    this.documents = documents || null;
    this.blobs = blobs || null;
    this.logger = log || logger;
    this.policy = policy;
  }

  /** Whether this repository can store anything. @returns {boolean} */
  isAvailable() {
    return Boolean(this.documents && this.blobs);
  }

  /**
   * The scope to act on, or null once the call has to be a no-op.
   *
   * @param {Object} scope - Scope as the caller passed it.
   * @param {string} operation - Method name, for the log line.
   * @returns {{type: string, id: string}|null}
   * @private
   */
  _scope(scope, operation) {
    if (!this.isAvailable()) return null;
    const normalized = normalizeScope(scope);
    if (!normalized) {
      this.logger.debug?.('Artifact scope is not storable; skipping', {
        component: COMPONENT,
        operation,
        scopeType: String(scope?.type).slice(0, 32),
        scopeId: String(scope?.id).slice(0, 64)
      });
      return null;
    }
    return normalized;
  }

  /**
   * Store one artifact.
   *
   * @param {{type: string, id: string}} scope - What this belongs to.
   * @param {Object} artifact
   * @param {string} [artifact.kind='image'] - What it is; see `artifactPolicy`.
   * @param {string} artifact.mimeType - Media type, e.g. `image/png`.
   * @param {string} artifact.data - Base64 payload, without a data-URI prefix.
   * @param {string} [artifact.name] - Display name, when the producer gave one.
   * @param {string} [artifact.runId] - Run that produced it, for forensics and
   *   for joining an artifact back to what made it.
   * @returns {Promise<Object|null>} The descriptor to record, or null when
   *   nothing was stored — storage down, scope unusable, policy off.
   */
  async put(scope, { kind, mimeType, data, name, runId } = {}) {
    const target = this._scope(scope, 'put');
    if (!target) return null;
    const payload = toPayload(data);
    if (!payload || payload.length === 0) return null;
    if (this.policy().enabled === false) return null;
    const id = randomUUID().replace(/-/g, '');
    const key = artifactKey(target, id);
    // `isValidId` caps a key at 100 characters. A uuid scope id leaves room to
    // spare; an unusually long one does not, and a rejected key would throw
    // out of the producer's write path for the sake of an attachment.
    if (!isValidId(key)) {
      this.logger.warn('Artifact not stored: scope id leaves no room for a key', {
        component: COMPONENT,
        scopeType: target.type,
        scopeId: target.id
      });
      return null;
    }
    const storedKind = artifactKind(kind);
    const type = artifactMediaType(storedKind, mimeType);
    const label = typeof name === 'string' && name ? name.slice(0, MAX_ARTIFACT_NAME_CHARS) : null;

    // Payload first, metadata second. The reverse order would let a failed
    // blob write leave a descriptor pointing at nothing — a broken picture for
    // the life of the producer — whereas this order's failure mode is a blob
    // nothing points at, which `deleteScope` sweeps by key prefix.
    const ref = await this.blobs.put(ARTIFACTS_NAMESPACE, key, payload, { contentType: type });

    const body = {
      version: ARTIFACT_VERSION,
      // The scope is in the document as well as in the key, so a read or a
      // sweep can prove an artifact belongs to the scope asking for it rather
      // than trusting a key prefix to be unambiguous.
      scope: target,
      kind: storedKind,
      mimeType: type,
      // What the content actually weighs, not what an encoding of it weighs:
      // the payload is stored as raw bytes, so this is the number a viewer
      // sees and the number the caps are measured in.
      bytes: ref.bytes,
      // The blob facet keeps no metadata of its own, so the digest lives here,
      // next to everything else that describes the payload.
      sha256: ref.sha256,
      ...(label ? { name: label } : {}),
      ...(typeof runId === 'string' && runId ? { runId } : {}),
      createdAt: new Date().toISOString()
    };
    try {
      await this.documents.put(ARTIFACTS_NAMESPACE, key, body);
    } catch (error) {
      // Do not leave the payload behind when its only index failed to land.
      // Best effort: `deleteScope` would find it eventually either way.
      await this.blobs.delete(ARTIFACTS_NAMESPACE, key).catch(() => {});
      throw error;
    }
    return toDescriptor(id, body);
  }

  /**
   * One stored artifact, payload included.
   *
   * @param {{type: string, id: string}} scope - Scope the caller is authorized for.
   * @param {string} artifactId - Artifact id from a descriptor.
   * @returns {Promise<Object|null>} The artifact with its `data`, or null.
   */
  async get(scope, artifactId) {
    const target = this._scope(scope, 'get');
    if (!target) return null;
    if (!isValidId(artifactId)) return null;
    const key = artifactKey(target, artifactId);
    if (!isValidId(key)) return null;
    const doc = await this.documents.get(ARTIFACTS_NAMESPACE, key);
    const data = doc?.data;
    if (!data) return null;
    // The key already scopes the artifact; this is the second wall, and the
    // one that does not depend on the separator being unambiguous. Checked
    // before the payload is read, so a mismatch costs nothing.
    if (data.scope && !sameScope(data.scope, target)) return null;
    const blob = await this.blobs.get(ARTIFACTS_NAMESPACE, key);
    if (!blob) {
      // Metadata without a payload: the blob store lost it, or a half-finished
      // delete. Reported rather than returned as an empty artifact.
      this.logger.warn('Artifact metadata has no payload', {
        component: COMPONENT,
        scopeType: target.type,
        scopeId: target.id,
        artifactId
      });
      return null;
    }
    return { ...toDescriptor(artifactId, data), data: blob.data };
  }

  /**
   * Everything one scope produced, newest first, as descriptors without
   * payloads.
   *
   * This is what a "what did this produce" view reads: the walk is over the
   * artifact keys, so it does not depend on the producer's own documents, and
   * `includeData: false` keeps it from loading a megabyte per entry.
   *
   * @param {{type: string, id: string}} scope - Scope to list.
   * @returns {Promise<Array<Object>>} Descriptors, newest first.
   */
  async list(scope) {
    const target = this._scope(scope, 'list');
    if (!target) return [];
    const prefix = scopePrefix(target);
    const entries = [];
    for (const doc of await this._scan(target, { includeData: true })) {
      if (!doc.data || (doc.data.scope && !sameScope(doc.data.scope, target))) continue;
      entries.push(toDescriptor(doc.key.slice(prefix.length), doc.data));
    }
    entries.sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
    return entries;
  }

  /**
   * Remove named artifacts of a scope.
   *
   * Best effort: whatever referenced them is already gone by the time this
   * runs, so a failure here is a leftover to sweep rather than an outcome to
   * report.
   *
   * @param {{type: string, id: string}} scope - Scope they belong to.
   * @param {string[]} artifactIds - Ids to remove.
   * @returns {Promise<number>} How many documents were removed.
   */
  async deleteMany(scope, artifactIds) {
    const target = this._scope(scope, 'deleteMany');
    if (!target) return 0;
    let removed = 0;
    for (const artifactId of artifactIds || []) {
      if (!isValidId(artifactId)) continue;
      const key = artifactKey(target, artifactId);
      if (!isValidId(key)) continue;
      if (await this._delete(key, target)) removed += 1;
    }
    return removed;
  }

  /**
   * Remove every artifact of a scope.
   *
   * Driven by the key prefix rather than by whatever referenced them: a
   * producer's own documents are deleted in the same cascade, and an artifact
   * whose descriptor never landed (the producer's write failed after the
   * payload was stored) would otherwise have nothing left pointing at it, in a
   * namespace nobody enumerates.
   *
   * @param {{type: string, id: string}} scope - Scope to empty.
   * @returns {Promise<number>} How many documents were removed.
   */
  async deleteScope(scope) {
    const target = this._scope(scope, 'deleteScope');
    if (!target) return 0;
    const keys = new Set();
    for (const doc of await this._scan(target, { includeData: false })) keys.add(doc.key);
    // And the payloads, by their own prefix. A blob whose metadata never
    // landed is unreachable through the documents, and this namespace is not
    // enumerated anywhere else — so the only way to collect it is to ask the
    // blob store what it is holding for this scope.
    for (const key of await this._scanBlobs(target)) keys.add(key);
    let removed = 0;
    for (const key of keys) {
      if (await this._delete(key, target)) removed += 1;
    }
    return removed;
  }

  /**
   * The payload keys of one scope, by key prefix.
   *
   * @param {{type: string, id: string}} scope - Validated scope.
   * @returns {Promise<string[]>} Keys, empty when the walk failed.
   * @private
   */
  async _scanBlobs(scope) {
    const prefix = scopePrefix(scope);
    const keys = [];
    try {
      let cursor = null;
      do {
        const page = await this.blobs.list(ARTIFACTS_NAMESPACE, { prefix, cursor });
        for (const item of page.items || []) keys.push(item.key);
        cursor = page.nextCursor || null;
      } while (cursor);
    } catch (error) {
      this.logger.error("Failed to enumerate a scope's artifact payloads", {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        error: error.message
      });
      return [];
    }
    return keys.filter(key => !key.slice(prefix.length).includes(KEY_SEPARATOR));
  }

  /**
   * Delete one artifact — both halves — logging rather than throwing.
   *
   * The document goes first: it is the only thing that can find the payload,
   * so a failure between the two leaves a blob the prefix sweep still
   * collects, rather than a descriptor pointing at bytes that are gone.
   *
   * @param {string} key - Artifact key.
   * @param {{type: string, id: string}} scope - Scope, for the log line.
   * @returns {Promise<boolean>} Whether anything went.
   * @private
   */
  async _delete(key, scope) {
    let removed = false;
    try {
      removed = await this.documents.delete(ARTIFACTS_NAMESPACE, key);
    } catch (error) {
      this.logger.error('Failed to delete an artifact', {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        key,
        error: error.message
      });
    }
    try {
      if (await this.blobs.delete(ARTIFACTS_NAMESPACE, key)) removed = true;
    } catch (error) {
      this.logger.error('Failed to delete an artifact payload', {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        key,
        error: error.message
      });
    }
    return removed;
  }

  /**
   * The artifact documents of one scope, by key prefix.
   *
   * A scope id that itself contains the key separator would make this prefix
   * match another scope's keys (`a` matching `a__b`'s). The suffix is an
   * artifact id and never carries the separator, so anything with more than
   * one is somebody else's and is dropped here rather than in each caller.
   *
   * @param {{type: string, id: string}} scope - Validated scope.
   * @param {Object} [options]
   * @param {boolean} [options.includeData=false] - Load the payloads too.
   * @returns {Promise<Array<Object>>} Documents, empty when the walk failed.
   * @private
   */
  async _scan(scope, { includeData = false } = {}) {
    const prefix = scopePrefix(scope);
    const docs = [];
    try {
      if (this.documents.supportsScan) {
        for await (const doc of this.documents.scan(ARTIFACTS_NAMESPACE, { prefix, includeData })) {
          docs.push(doc);
        }
      } else {
        let cursor = null;
        do {
          const page = await this.documents.list(ARTIFACTS_NAMESPACE, {
            prefix,
            includeData,
            cursor
          });
          for (const doc of page.items || []) docs.push(doc);
          cursor = page.nextCursor || null;
        } while (cursor);
      }
    } catch (error) {
      this.logger.error("Failed to enumerate a scope's artifacts", {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        error: error.message
      });
      return [];
    }
    return docs.filter(doc => !doc.key.slice(prefix.length).includes(KEY_SEPARATOR));
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide artifact repository, rebuilt when the provider changes.
 *
 * @returns {ArtifactRepository}
 */
export function getArtifactRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ArtifactRepository({
      documents: readFacet(provider, 'documents'),
      blobs: readFacet(provider, 'blobs'),
      logger
    });
  }
  return cachedRepository;
}

export default ArtifactRepository;
