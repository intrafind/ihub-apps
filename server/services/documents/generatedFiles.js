import { createHash } from 'crypto';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getArtifactRepository } from '../artifacts/ArtifactRepository.js';

/**
 * Files a tool generated for a user — a PDF the model created on request,
 * later a DOCX, PPTX or XLSX.
 *
 * They are stored as artifacts in the `user` scope, keyed by the owner, so a
 * file does not depend on the chat being stored (durable chats are optional)
 * and only its owner can download it (`GET /api/generated-files/:id`).
 * Anonymous users share one owner key; for them the random file id is what
 * keeps a file private, like a share link.
 *
 * Files are swept by age — as long as chats are kept
 * (`platform.chats.retentionDays`) — and each owner keeps at most
 * {@link MAX_FILES_PER_OWNER}.
 */

const COMPONENT = 'GeneratedFiles';
const SCOPE_TYPE = 'user';
const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_GENERATED_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_OWNER = 200;
const DEFAULT_RETENTION_DAYS = 90;

/** Media types a generated file may have, with the extension it gets. */
export const GENERATED_FILE_TYPES = Object.freeze({
  'application/pdf': 'pdf'
});

export class GeneratedFileError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'GeneratedFileError';
    this.code = code;
  }
}

/**
 * The owner key a user's files are stored under. A user id may contain
 * characters a storage key cannot (`@`, `:`), so it is hashed.
 *
 * @param {Object|null|undefined} user
 * @returns {string}
 */
export function ownerKeyOf(user) {
  const id = user?.id;
  if (!id || id === 'anonymous' || typeof id !== 'string') return 'anonymous';
  return `u${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

function scopeOf(user) {
  return { type: SCOPE_TYPE, id: ownerKeyOf(user) };
}

/**
 * A download file name: no path, no control characters, the right extension.
 *
 * @param {unknown} name
 * @param {string} extension - Without the dot.
 * @returns {string}
 */
export function safeFileName(name, extension) {
  const base = String(typeof name === 'string' ? name : '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return `${base || 'document'}.${extension}`;
}

function retentionDays() {
  const configured = Number(configCache.getPlatform()?.chats?.retentionDays);
  return Number.isFinite(configured) ? configured : DEFAULT_RETENTION_DAYS;
}

/**
 * Epoch milliseconds before which a generated file has expired, or null when
 * files are kept indefinitely (`retentionDays` zero or less).
 *
 * @returns {number|null}
 */
function retentionCutoff() {
  const days = retentionDays();
  return days > 0 ? Date.now() - days * DAY_MS : null;
}

function isExpired(entry, cutoff = retentionCutoff()) {
  if (cutoff === null) return false;
  const created = Date.parse(entry?.createdAt || '');
  return Number.isFinite(created) && created < cutoff;
}

/**
 * Remove an owner's files past the retention window and beyond the cap.
 * Best effort: a failed sweep never fails the save that triggered it.
 */
async function sweep(repository, scope) {
  try {
    const entries = await repository.list(scope); // newest first
    const cutoff = retentionCutoff();
    const expired = entries
      .filter((entry, index) => index >= MAX_FILES_PER_OWNER || isExpired(entry, cutoff))
      .map(entry => entry.id);
    if (expired.length) await repository.deleteMany(scope, expired);
  } catch (error) {
    logger.warn('Sweeping generated files failed', { component: COMPONENT, error: error.message });
  }
}

/**
 * Store a generated file for its owner.
 *
 * @param {Object} params
 * @param {Object} params.user - The user the file is for.
 * @param {Buffer} params.data
 * @param {string} params.mimeType - A key of {@link GENERATED_FILE_TYPES}.
 * @param {string} [params.name] - Download name; the extension is added.
 * @param {Object} [params.meta] - Extra fields for the descriptor (e.g. `pages`).
 * @param {import('../artifacts/ArtifactRepository.js').ArtifactRepository} [params.repository] -
 *   Artifact store; defaults to the shared one.
 * @returns {Promise<{ id: string, name: string, mimeType: string, bytes: number, createdAt: string }>}
 */
export async function saveGeneratedFile({
  user,
  data,
  mimeType,
  name,
  meta = {},
  repository = getArtifactRepository()
}) {
  const extension = GENERATED_FILE_TYPES[mimeType];
  if (!extension) throw new GeneratedFileError(`Unsupported file type: ${mimeType}`, 'invalid');
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new GeneratedFileError('The generated file is empty.', 'invalid');
  }
  if (data.length > MAX_GENERATED_FILE_BYTES) {
    throw new GeneratedFileError(
      `The generated file is larger than ${MAX_GENERATED_FILE_BYTES / 1024 / 1024} MB.`,
      'too-large'
    );
  }
  if (!repository.isAvailable()) {
    throw new GeneratedFileError('File storage is not available on this server.', 'unavailable');
  }
  const scope = scopeOf(user);
  const fileName = safeFileName(name, extension);
  const descriptor = await repository.put(scope, {
    kind: 'document',
    mimeType,
    data,
    name: fileName
  });
  if (!descriptor) {
    throw new GeneratedFileError(
      'The file could not be stored (artifact storage is disabled).',
      'unavailable'
    );
  }
  await sweep(repository, scope);
  return {
    id: descriptor.id,
    name: fileName,
    mimeType: descriptor.mimeType,
    bytes: descriptor.bytes,
    createdAt: descriptor.createdAt,
    ...meta
  };
}

/**
 * Read one of a user's generated files.
 *
 * @param {Object} user
 * @param {string} fileId
 * @param {Object} [options]
 * @param {import('../artifacts/ArtifactRepository.js').ArtifactRepository} [options.repository]
 * @returns {Promise<{ id: string, name?: string, mimeType: string, bytes: number, data: Buffer } | null>}
 */
export async function getGeneratedFile(
  user,
  fileId,
  { repository = getArtifactRepository() } = {}
) {
  if (!isValidId(fileId) || !/^[a-f0-9]{32}$/.test(fileId)) return null;
  if (!repository.isAvailable()) return null;
  const scope = scopeOf(user);
  const file = await repository.get(scope, fileId);
  if (!file) return null;
  // Past the retention window a file is gone, whether or not the daily sweep
  // has reached it yet.
  if (isExpired(file)) {
    await repository.deleteMany(scope, [fileId]).catch(() => {});
    return null;
  }
  return file;
}

/**
 * Remove every generated file past the retention window, for all owners.
 *
 * @param {Object} [options]
 * @param {import('../artifacts/ArtifactRepository.js').ArtifactRepository} [options.repository]
 * @returns {Promise<number>} How many files were removed.
 */
export async function sweepExpiredGeneratedFiles({ repository = getArtifactRepository() } = {}) {
  const cutoff = retentionCutoff();
  if (cutoff === null || !repository.isAvailable()) return 0;
  const removed = await repository.deleteCreatedBefore(SCOPE_TYPE, cutoff);
  if (removed > 0) {
    logger.info('Expired generated files removed', { component: COMPONENT, removed });
  }
  return removed;
}

let sweepTimer = null;

/**
 * Sweep expired generated files once now and then daily. Owners that never
 * generate another file would otherwise keep theirs past the window.
 *
 * @param {Object} [options]
 * @param {number} [options.intervalMs]
 * @returns {() => void} Stops the sweep.
 */
export function startGeneratedFileSweep({ intervalMs = DAY_MS } = {}) {
  if (sweepTimer) return stopGeneratedFileSweep;
  const tick = () =>
    sweepExpiredGeneratedFiles().catch(error =>
      logger.warn('Generated file sweep failed', { component: COMPONENT, error: error.message })
    );
  sweepTimer = setInterval(tick, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  tick();
  return stopGeneratedFileSweep;
}

/** Stop the daily sweep. */
export function stopGeneratedFileSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/**
 * The client-facing descriptor of a generated file: what a tool result and
 * the chat's download card carry.
 *
 * @param {Object} file - From {@link saveGeneratedFile}.
 * @returns {Object}
 */
export function describeGeneratedFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    bytes: file.bytes,
    ...(Number.isInteger(file.pages) ? { pages: file.pages } : {}),
    createdAt: file.createdAt
  };
}
