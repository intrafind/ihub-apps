// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ZIP archives of artifacts — the download of several of a chat's artifacts
 * (`POST /api/chats/:chatId/artifacts/zip`, and a share's twin) and the
 * archive the `create_zip` tool builds.
 *
 * Both go through {@link planZipEntries} first, which decides the path of
 * every file in the archive and enforces the configured limits
 * (`platform.artifacts.maxZipFiles` / `maxZipBytes`) before a single byte is
 * read, and then through {@link writeZip}.
 *
 * @module services/artifacts/artifactZip
 */
import { PassThrough } from 'node:stream';
import { ZipArchive } from 'archiver';
import { safeArchivePath } from '../documents/generatedFiles.js';
import { artifactPolicy } from './artifactPolicy.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import logger from '../../utils/logger.js';

export class ZipLimitError extends Error {
  /**
   * @param {string} message
   * @param {'too-many-files'|'too-large'|'empty'|'closed'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ZipLimitError';
    this.code = code;
  }
}

/**
 * A path not used yet: `report.md`, then `report (2).md`, `report (3).md`.
 * Compared case-insensitively, because the archive is unpacked on file
 * systems that are.
 *
 * @param {string} path
 * @param {Set<string>} used - Lower-cased paths taken so far; updated.
 * @returns {string}
 */
export function uniqueArchivePath(path, used) {
  let candidate = path;
  if (used.has(candidate.toLowerCase())) {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const hasExtension = dot > slash + 1;
    const stem = hasExtension ? path.slice(0, dot) : path;
    const extension = hasExtension ? path.slice(dot) : '';
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      candidate = `${stem} (${n})${extension}`;
    }
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Decide the archive path of every file and check the limits.
 *
 * Paths are normalized with `safeArchivePath` (no `..`, no root, no drive),
 * and a path used twice gets a ` (2)` suffix. A file and a folder of the
 * same name (`a` and `a/b`) cannot both exist in an unpacked archive, so the
 * file is renamed the same way.
 *
 * @template {{ name?: string, bytes?: number }} T
 * @param {T[]} items - What to pack, in archive order.
 * @param {Object} limits
 * @param {number} limits.maxFiles - `<= 0` removes the cap.
 * @param {number} limits.maxBytes - Content bytes, before compression;
 *   `<= 0` removes the cap.
 * @param {(item: T, index: number) => string} [limits.fallbackName] - Name
 *   for an item whose own is empty after normalization.
 * @returns {Array<T & { path: string }>}
 * @throws {ZipLimitError}
 */
export function planZipEntries(items, { maxFiles, maxBytes, fallbackName } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0)
    throw new ZipLimitError('There are no files to put in the archive.', 'empty');
  if (maxFiles > 0 && list.length > maxFiles) {
    throw new ZipLimitError(
      `An archive holds at most ${maxFiles} files; ${list.length} were requested.`,
      'too-many-files'
    );
  }
  const total = list.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  if (maxBytes > 0 && total > maxBytes) {
    throw new ZipLimitError(
      `An archive holds at most ${formatMegabytes(maxBytes)} of content; the files add up to ${formatMegabytes(total)}.`,
      'too-large'
    );
  }
  const used = new Set();
  const folders = new Set();
  const planned = list.map((item, index) => {
    const path =
      safeArchivePath(item.name) ||
      safeArchivePath(fallbackName?.(item, index)) ||
      `file-${index + 1}`;
    return { item, path };
  });
  // Every folder any path implies, so a file cannot take a folder's name.
  for (const { path } of planned) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      folders.add(parts.slice(0, i).join('/').toLowerCase());
    }
  }
  for (const folder of folders) used.add(folder);
  return planned.map(({ item, path }) => ({ ...item, path: uniqueArchivePath(path, used) }));
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Write a ZIP archive to a stream.
 *
 * @param {Array<{ path: string, data: Buffer, date?: string|Date }>} entries
 * @param {import('node:stream').Writable} output
 * @returns {Promise<void>} Resolves once the archive is finalized.
 */
export async function writeZip(entries, output) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const failed = new Promise((_, reject) => {
    archive.on('error', reject);
    archive.on('warning', reject);
  });
  // A client that goes away mid-download closes the response; nothing reads
  // the archive any more, so it would wait on backpressure for ever and hold
  // every payload. Abort it and settle instead.
  const closed = new Promise((_, reject) => {
    output.once('close', () => {
      if (output.writableFinished) return;
      archive.abort();
      reject(new ZipLimitError('The download was closed before it finished.', 'closed'));
    });
  });
  archive.pipe(output);
  for (const entry of entries) {
    const date = entry.date ? new Date(entry.date) : new Date();
    archive.append(entry.data, {
      name: entry.path,
      date: Number.isNaN(date.getTime()) ? new Date() : date
    });
  }
  // Settled once the race is decided; a late event must not surface as an
  // unhandled rejection.
  failed.catch(() => {});
  closed.catch(() => {});
  await Promise.race([archive.finalize(), failed, closed]);
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{ path: string, data: Buffer, date?: string|Date }>} entries
 * @returns {Promise<Buffer>}
 */
export async function zipToBuffer(entries) {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', chunk => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
  });
  await writeZip(entries, sink);
  await ended;
  return Buffer.concat(chunks);
}

/**
 * A file name for a downloaded artifact, from its stored name or its kind.
 *
 * @param {Object} artifact - Artifact with `name`, `kind`, `mimeType`, `id`.
 * @returns {string}
 */
export function downloadName(artifact) {
  const stored = typeof artifact.name === 'string' ? artifact.name.trim() : '';
  // Well-formed and cut by code point: the stored name was capped in UTF-16
  // units, which can leave half a surrogate pair behind, and a name with a
  // lone surrogate is not encodable — the download would answer 500.
  if (stored) {
    const wellFormed = stored.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '_'
    );
    return Array.from(wellFormed.replace(/[\r\n"\\/]+/g, '_'))
      .slice(0, 200)
      .join('');
  }
  const ext =
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'text/plain': 'txt',
      'text/markdown': 'md',
      'text/csv': 'csv',
      'application/json': 'json',
      'application/zip': 'zip'
    }[artifact.mimeType] || 'bin';
  return `${artifact.kind || 'artifact'}-${String(artifact.id).slice(0, 8)}.${ext}`;
}

/** Most ids one ZIP request may name. */
export const MAX_ZIP_REQUEST_IDS = 1000;

/**
 * Answer a ZIP download of artifacts of one scope the route has authorized.
 *
 * `artifactIds` omitted packs every descriptor given, oldest first; a list
 * packs those, in its order, and an id that is not among the descriptors
 * answers `404` like an unknown artifact does on the single-artifact route.
 * The limits are checked on the recorded sizes before any payload is read,
 * and answer `413`.
 *
 * Folders in artifact names (`src/index.js`) are kept in the archive; a
 * duplicate path gets a ` (2)` suffix.
 *
 * @param {import('express').Response} res
 * @param {Object} params
 * @param {import('./ArtifactRepository.js').ArtifactRepository} params.repository
 * @param {{type: string, id: string}} params.scope - Authorized scope.
 * @param {Object[]} params.descriptors - What the caller may download, newest first.
 * @param {unknown} params.artifactIds - From the request body.
 * @param {string} [params.archiveName] - Download name of the archive.
 * @param {(res: import('express').Response) => void} [params.beforeSend] - Extra headers.
 * @returns {Promise<void>}
 */
export async function sendArtifactsZip(
  res,
  { repository, scope, descriptors, artifactIds, archiveName = 'artifacts.zip', beforeSend }
) {
  let selected;
  if (artifactIds === undefined || artifactIds === null) {
    selected = [...descriptors].reverse();
  } else {
    if (
      !Array.isArray(artifactIds) ||
      artifactIds.length > MAX_ZIP_REQUEST_IDS ||
      !artifactIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))
    ) {
      res.status(400).json({ error: '"artifactIds" must be a list of artifact ids.' });
      return;
    }
    const byId = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
    const unique = [...new Set(artifactIds)];
    if (unique.some(id => !byId.has(id))) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }
    selected = unique.map(id => byId.get(id));
  }

  const { maxZipFiles, maxZipBytes } = artifactPolicy();
  let planned;
  try {
    planned = planZipEntries(selected, {
      maxFiles: maxZipFiles,
      maxBytes: maxZipBytes,
      fallbackName: downloadName
    });
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    res.status(error.code === 'empty' ? 404 : 413).json({ error: error.message, code: error.code });
    return;
  }

  // Read before the first byte goes out: a payload missing now can still be
  // answered with a status, which a half-written archive cannot.
  const entries = [];
  for (const item of planned) {
    const artifact = await repository.get(scope, item.id);
    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }
    entries.push({ path: item.path, data: artifact.data, date: artifact.createdAt });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', buildContentDisposition(archiveName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  beforeSend?.(res);
  try {
    await writeZip(entries, res);
  } catch (error) {
    if (error instanceof ZipLimitError && error.code === 'closed') return;
    logger.error('Artifact ZIP failed while streaming', {
      component: 'ArtifactZip',
      scopeType: scope?.type,
      error: error.message
    });
    res.destroy(error);
  }
}
