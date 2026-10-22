// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ItemTextStore — the encrypted text of a project item in the
 * `project-files` blob namespace (spec 3 §5).
 *
 *  - `storeText` mints a data key, encrypts the text in the streaming AEAD
 *    format, wraps the key with the configured `KeyProvider`, writes the blob
 *    under `<projectId>__<itemId>__<versionId>` and returns the `text` block
 *    the item records (the wrapped key included).
 *  - `readText` unwraps the key (cached for ten minutes per blob) and
 *    decrypts; the plaintext hash is verified.
 *
 * The item document is written by the caller **after** the blob, and a
 * failed document write deletes the blob it just stored, as artifacts do.
 *
 * @module services/projects/ItemTextStore
 */
import crypto from 'node:crypto';
import logger from '../../utils/logger.js';
import { estimateTokens } from '../../../shared/tokenEstimator.js';
import { KnowledgeError } from '../knowledge/types.js';
import { PROJECT_FILES_NAMESPACE, getProjectRepository } from './ProjectRepository.js';
import { projectSettings } from './projectSettings.js';
import { KeyAccessDenied, getKeyProvider } from './crypto/KeyProvider.js';
import {
  DEFAULT_SEGMENT_BYTES,
  FORMAT_ID,
  associatedDataOf,
  decrypt,
  encrypt,
  newDataKey
} from './crypto/streamingAead.js';

const COMPONENT = 'ItemTextStore';

/** Unwrapped data keys kept in memory, and for how long. */
const KEY_CACHE_TTL_MS = 10 * 60 * 1000;
const KEY_CACHE_ENTRIES = 256;
const keyCache = new Map();

function cacheKey(blobKey, dataKey) {
  keyCache.set(blobKey, { dataKey, at: Date.now() });
  while (keyCache.size > KEY_CACHE_ENTRIES) keyCache.delete(keyCache.keys().next().value);
}

function cachedKey(blobKey) {
  const entry = keyCache.get(blobKey);
  if (!entry) return null;
  if (Date.now() - entry.at > KEY_CACHE_TTL_MS) {
    keyCache.delete(blobKey);
    return null;
  }
  return entry.dataKey;
}

/** Forget cached keys (a removed item, a rotated key, tests). */
export function evictItemKeys(blobKey) {
  if (blobKey) keyCache.delete(blobKey);
  else keyCache.clear();
}

/** A time-ordered version id for a blob key. */
export function mintVersionId(now = Date.now()) {
  return `${now.toString(36).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`;
}

function keyProviderFor(platform) {
  return getKeyProvider(projectSettings(platform).encryption.keyProvider);
}

/**
 * Encrypt and store a text; return the item's `text` block.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {string} options.itemId
 * @param {string} options.text - The extracted text.
 * @param {{contentType?: string, bytes?: number, pages?: number}} [options.original]
 * @param {boolean} [options.truncated]
 * @param {Object} [options.platform] - Platform configuration (for the key provider).
 * @param {import('./ProjectRepository.js').ProjectRepository} [options.repository]
 * @param {string} [options.tenant='default']
 * @returns {Promise<Object>} The `text` block (spec 1 §3).
 */
export async function storeText({
  projectId,
  itemId,
  text,
  original = {},
  truncated = false,
  platform = {},
  repository = getProjectRepository(),
  tenant = 'default'
}) {
  if (!repository.hasBlobs()) {
    throw new KnowledgeError('STORAGE_UNAVAILABLE', 'No blob store is available for project text', {
      projectId,
      itemId
    });
  }
  const versionId = mintVersionId();
  const blobKey = `${projectId}__${itemId}__${versionId}`;
  const aad = associatedDataOf({ tenant, projectId, itemId, versionId });
  const plaintext = Buffer.from(text, 'utf8');
  const dataKey = newDataKey();
  const provider = keyProviderFor(platform);
  const { keyId, wrapped } = await provider.wrap(dataKey, aad);
  const ciphertext = encrypt(plaintext, dataKey, aad, { segmentBytes: DEFAULT_SEGMENT_BYTES });
  const stored = await repository.blobs.put(PROJECT_FILES_NAMESPACE, blobKey, ciphertext);
  cacheKey(blobKey, dataKey);
  return {
    blobKey,
    bytes: stored.bytes,
    chars: text.length,
    tokens: estimateTokens(text),
    sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
    format: FORMAT_ID,
    segmentBytes: DEFAULT_SEGMENT_BYTES,
    key: { provider: provider.id, keyId, wrapped: wrapped.toString('base64') },
    tenant,
    extractedAt: new Date().toISOString(),
    ...(truncated ? { truncated: true } : {}),
    original: {
      ...(original.contentType ? { contentType: original.contentType } : {}),
      ...(Number.isFinite(original.bytes) ? { bytes: original.bytes } : {}),
      ...(Number.isFinite(original.pages) ? { pages: original.pages } : {})
    }
  };
}

/**
 * Decrypt a stored text.
 *
 * @param {Object} project
 * @param {Object} item - With its `text` block.
 * @param {{platform?: Object, repository?: Object, tenant?: string}} [options]
 * @returns {Promise<string>}
 * @throws {KnowledgeError} `TEXT_UNAVAILABLE` (no blob, wrong format, hash mismatch),
 *   `KEY_ACCESS_DENIED` (the master key cannot unwrap).
 */
export async function readText(
  project,
  item,
  { platform = {}, repository = getProjectRepository(), tenant = 'default' } = {}
) {
  const where = { projectId: project?.id, itemId: item?.id };
  const block = item?.text;
  if (!block?.blobKey)
    throw new KnowledgeError('TEXT_UNAVAILABLE', 'The item holds no text', where);
  if (block.format !== FORMAT_ID) {
    throw new KnowledgeError('TEXT_UNAVAILABLE', `Unknown text format ${block.format}`, where);
  }
  if (!repository.hasBlobs()) {
    throw new KnowledgeError('STORAGE_UNAVAILABLE', 'No blob store is available', where);
  }
  const blob = await repository.blobs.get(PROJECT_FILES_NAMESPACE, block.blobKey);
  if (!blob) throw new KnowledgeError('TEXT_UNAVAILABLE', 'The stored text is gone', where);
  const versionId = block.blobKey.slice(`${project.id}__${item.id}__`.length);
  // The tenant the object was encrypted under is the item's, not the
  // request's: a later tenant-aware derivation changes nothing for it.
  const aad = associatedDataOf({
    tenant: block.tenant || tenant,
    projectId: project.id,
    itemId: item.id,
    versionId
  });
  let dataKey = cachedKey(block.blobKey);
  if (!dataKey) {
    const provider = getKeyProvider(
      block.key?.provider || projectSettings(platform).encryption.keyProvider
    );
    try {
      dataKey = await provider.unwrap(
        Buffer.from(block.key?.wrapped || '', 'base64'),
        block.key?.keyId,
        aad
      );
    } catch (error) {
      if (error instanceof KeyAccessDenied) {
        logger.error('A project item key did not unwrap', {
          component: COMPONENT,
          ...where,
          keyId: error.keyId
        });
        throw new KnowledgeError('KEY_ACCESS_DENIED', error.message, where);
      }
      throw error;
    }
    cacheKey(block.blobKey, dataKey);
  }
  let plaintext;
  try {
    plaintext = decrypt(blob.data, dataKey, aad, {
      segmentBytes: block.segmentBytes || DEFAULT_SEGMENT_BYTES
    });
  } catch (error) {
    throw new KnowledgeError(
      'TEXT_UNAVAILABLE',
      `The stored text does not verify (${error.message})`,
      where
    );
  }
  const sha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (block.sha256 && sha256 !== block.sha256) {
    throw new KnowledgeError('TEXT_UNAVAILABLE', 'The stored text does not match its hash', where);
  }
  return plaintext.toString('utf8');
}
