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

/**
 * The hash a `text` block records (`sha256`): SHA-256 of the UTF-8 plaintext,
 * hex. `storeText` records it, `readText` verifies it, and a refresh compares
 * a new extraction with it to tell an unchanged text (#3622).
 *
 * @param {string|Buffer} text - The text, or its UTF-8 bytes.
 * @returns {string}
 */
export function textSha256(text) {
  const plaintext = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function keyProviderFor(platform) {
  return getKeyProvider(projectSettings(platform).encryption.keyProvider);
}

/**
 * Encrypt bytes under a fresh data key and store them as one blob of the item.
 *
 * @returns {Promise<Object>} The common part of a stored block: where it is,
 *   how it is encrypted and the plaintext hash.
 */
async function sealBytes({ projectId, itemId, plaintext, platform, repository, tenant }) {
  if (!repository.hasBlobs()) {
    throw new KnowledgeError(
      'STORAGE_UNAVAILABLE',
      'No blob store is available for project files',
      {
        projectId,
        itemId
      }
    );
  }
  const versionId = mintVersionId();
  const blobKey = `${projectId}__${itemId}__${versionId}`;
  const aad = associatedDataOf({ tenant, projectId, itemId, versionId });
  const dataKey = newDataKey();
  const provider = keyProviderFor(platform);
  const { keyId, wrapped } = await provider.wrap(dataKey, aad);
  const ciphertext = encrypt(plaintext, dataKey, aad, { segmentBytes: DEFAULT_SEGMENT_BYTES });
  const stored = await repository.blobs.put(PROJECT_FILES_NAMESPACE, blobKey, ciphertext);
  cacheKey(blobKey, dataKey);
  return {
    blobKey,
    bytes: stored.bytes,
    sha256: textSha256(plaintext),
    format: FORMAT_ID,
    segmentBytes: DEFAULT_SEGMENT_BYTES,
    key: { provider: provider.id, keyId, wrapped: wrapped.toString('base64') },
    tenant
  };
}

/**
 * Read and decrypt one stored block of an item, verifying its hash.
 *
 * @param {Object} project
 * @param {Object} item
 * @param {Object} block - The item's `text` or `originalFile` block.
 * @param {string} what - For the messages: "text" or "original".
 * @returns {Promise<Buffer>}
 */
async function openBytes(project, item, block, what, { platform, repository, tenant }) {
  const where = { projectId: project?.id, itemId: item?.id };
  if (!block?.blobKey) {
    throw new KnowledgeError('TEXT_UNAVAILABLE', `The item holds no ${what}`, where);
  }
  if (block.format !== FORMAT_ID) {
    throw new KnowledgeError('TEXT_UNAVAILABLE', `Unknown ${what} format ${block.format}`, where);
  }
  if (!repository.hasBlobs()) {
    throw new KnowledgeError('STORAGE_UNAVAILABLE', 'No blob store is available', where);
  }
  const blob = await repository.blobs.get(PROJECT_FILES_NAMESPACE, block.blobKey);
  if (!blob) throw new KnowledgeError('TEXT_UNAVAILABLE', `The stored ${what} is gone`, where);
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
      `The stored ${what} does not verify (${error.message})`,
      where
    );
  }
  if (block.sha256 && textSha256(plaintext) !== block.sha256) {
    throw new KnowledgeError(
      'TEXT_UNAVAILABLE',
      `The stored ${what} does not match its hash`,
      where
    );
  }
  return plaintext;
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
  const sealed = await sealBytes({
    projectId,
    itemId,
    plaintext: Buffer.from(text, 'utf8'),
    platform,
    repository,
    tenant
  });
  return {
    ...sealed,
    chars: text.length,
    tokens: estimateTokens(text),
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
  const plaintext = await openBytes(project, item, item?.text, 'text', {
    platform,
    repository,
    tenant
  });
  return plaintext.toString('utf8');
}

/**
 * Encrypt and store the original file of an upload (when the installation
 * keeps originals: `platform.uploads.storageMode` is `original_and_text`);
 * return the item's `originalFile` block. Same format, key handling and key
 * prefix as the text, so every sweep and cascade that removes an item's
 * blobs removes its original too.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {string} options.itemId
 * @param {Buffer} options.bytes - The file as uploaded.
 * @param {string} [options.contentType]
 * @param {string} [options.name] - The file name, for a download.
 * @param {Object} [options.platform]
 * @param {Object} [options.repository]
 * @param {string} [options.tenant='default']
 * @returns {Promise<Object>} `{blobKey, bytes, size, contentType, name, sha256, …, storedAt}`;
 *   `size` is the plaintext size, `bytes` the stored (encrypted) size.
 */
export async function storeOriginal({
  projectId,
  itemId,
  bytes,
  contentType = 'application/octet-stream',
  name = 'document',
  platform = {},
  repository = getProjectRepository(),
  tenant = 'default'
}) {
  const sealed = await sealBytes({
    projectId,
    itemId,
    plaintext: bytes,
    platform,
    repository,
    tenant
  });
  return {
    ...sealed,
    size: bytes.length,
    contentType: String(contentType || 'application/octet-stream').slice(0, 200),
    name: String(name || 'document').slice(0, 300),
    storedAt: new Date().toISOString()
  };
}

/**
 * Decrypt a stored original file.
 *
 * @param {Object} project
 * @param {Object} item - With its `originalFile` block.
 * @param {{platform?: Object, repository?: Object, tenant?: string}} [options]
 * @returns {Promise<Buffer>}
 * @throws {KnowledgeError} `TEXT_UNAVAILABLE`, `KEY_ACCESS_DENIED` (as {@link readText}).
 */
export async function readOriginal(
  project,
  item,
  { platform = {}, repository = getProjectRepository(), tenant = 'default' } = {}
) {
  return openBytes(project, item, item?.originalFile, 'original', {
    platform,
    repository,
    tenant
  });
}
