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
import fs from 'node:fs/promises';
import { PassThrough, Transform, Writable, finished, pipeline } from 'node:stream';
import { ZipArchive } from 'archiver';
import { safeArchivePath } from '../documents/generatedFiles.js';
import { artifactPolicy } from './artifactPolicy.js';
import { withKitLibraries } from './artifactLibraryKit.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import logger from '../../utils/logger.js';
import { ServiceError } from '../../utils/ServiceError.js';

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
 * An entry is either in memory (`data`) or opened when its turn comes
 * (`open`), so that an archive of large files holds one open payload stream
 * and no payload in memory. Entries with `open` are appended one after the
 * other: the next one is opened only when the one before is in the archive.
 *
 * A stream entry that fails part-way (its store went away, a later part of
 * an encrypted payload does not verify) rejects the call; the archive is
 * aborted and never finalized, so the caller can make the failure visible
 * (destroy the response) instead of handing out an archive that looks whole.
 *
 * @param {Array<{ path: string, data?: Buffer,
 *   open?: () => Promise<import('node:stream').Readable>, date?: string|Date }>} entries
 * @param {import('node:stream').Writable} output
 * @returns {Promise<void>} Resolves once the archive is finalized.
 * @throws {ZipLimitError} Code `closed` when `output` closed first. What an
 *   entry's `open` or stream failed with, as it is.
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
  // Settled once the race is decided; a late event must not surface as an
  // unhandled rejection.
  failed.catch(() => {});
  closed.catch(() => {});
  archive.pipe(output);

  // One object, changed from the archiver's event handler and from the loop below.
  const progress = { appended: 0, processed: 0 };
  let wake = null;
  archive.on('entry', () => {
    progress.processed += 1;
    wake?.();
  });
  /** Resolves when everything appended so far is in the archive. */
  const drained = async () => {
    while (progress.processed < progress.appended) {
      await new Promise(resolve => {
        wake = resolve;
      });
    }
    wake = null;
  };
  const dated = entry => {
    const date = entry.date ? new Date(entry.date) : new Date();
    return { name: entry.path, date: Number.isNaN(date.getTime()) ? new Date() : date };
  };

  /** The stream entry being read, so that it is released however this ends. */
  let current = null;
  try {
    for (const entry of entries) {
      if (typeof entry.open !== 'function') {
        archive.append(entry.data, dated(entry));
        progress.appended += 1;
        continue;
      }
      await Promise.race([drained(), failed, closed]);
      current = await entry.open();
      // The archiver pipes a source and does not hear it fail: without this
      // a failed payload would leave the archive waiting for ever.
      const stream = current;
      // `finished` also reports a stream that failed before it got here.
      const broke = new Promise((_, reject) => {
        finished(stream, { writable: false }, error => {
          if (error) reject(error);
        });
      });
      broke.catch(() => {});
      archive.append(stream, dated(entry));
      progress.appended += 1;
      await Promise.race([drained(), failed, closed, broke]);
      current = null;
    }
    await Promise.race([archive.finalize(), failed, closed]);
  } catch (error) {
    // Unpiped first: aborting an archive ends it, and the pipe would pass
    // that on as a clean end of `output` one tick later. Whether a response
    // then went out as an empty `200` or as the error would depend on nothing
    // awaiting between this throw and the answer. The caller ends or
    // destroys `output`.
    archive.unpipe(output);
    archive.abort();
    throw error;
  } finally {
    current?.destroy();
  }
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
 * Build a ZIP archive into a file, so that neither the archive nor a member
 * that is opened as a stream is held in memory.
 *
 * Both limits are enforced while writing: the archive is aborted as soon as it
 * (or the content it was given) grows past its limit, and the file then holds
 * at most `maxArchiveBytes`. The caller owns the file and removes it, also
 * when this call throws.
 *
 * @param {Array<{ path: string, data?: Buffer,
 *   open?: () => Promise<import('node:stream').Readable>, date?: string|Date }>} entries
 * @param {string} filePath - An existing or new file; it is truncated.
 * @param {Object} [limits]
 * @param {number} [limits.maxArchiveBytes=0] - Largest archive; `<= 0` removes the cap.
 * @param {number} [limits.maxContentBytes=0] - Most content bytes (before
 *   compression) of all entries together; `<= 0` removes the cap. Counted as the
 *   bytes pass, so a member that is larger than its recorded size is caught.
 * @returns {Promise<{bytes: number, contentBytes: number}>} Size of the archive and of
 *   the content that went into it.
 * @throws {ZipLimitError} Code `too-large` when a limit was exceeded; `limit` is
 *   `'archive'` when it was the archive's size.
 */
export async function zipToFile(
  entries,
  filePath,
  { maxArchiveBytes = 0, maxContentBytes = 0 } = {}
) {
  const handle = await fs.open(filePath, 'w', 0o600);
  let bytes = 0;
  let contentBytes = 0;
  /** The limit that stopped the archive; what the caller is told instead of `closed`. */
  let limitError = null;
  const countContent = length => {
    contentBytes += length;
    if (maxContentBytes > 0 && contentBytes > maxContentBytes && !limitError) {
      limitError = new ZipLimitError(
        `An archive holds at most ${formatMegabytes(maxContentBytes)} of content; the files are larger than that.`,
        'too-large'
      );
    }
    return limitError;
  };
  const output = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (maxArchiveBytes > 0 && bytes > maxArchiveBytes) {
        if (!limitError) {
          limitError = new ZipLimitError(
            `The archive is larger than ${formatMegabytes(maxArchiveBytes)}.`,
            'too-large'
          );
          limitError.limit = 'archive';
        }
        return callback(limitError);
      }
      handle.write(chunk).then(() => callback(), callback);
    },
    final(callback) {
      handle.close().then(() => callback(), callback);
    },
    destroy(error, callback) {
      handle
        .close()
        .catch(() => {})
        .then(() => callback(error));
    }
  });
  // Heard here, or a failed write would be an unhandled 'error' event.
  let outputError = null;
  output.on('error', error => {
    outputError = error;
  });
  const done = new Promise(resolve => finished(output, () => resolve()));

  const counted = entries.map(entry => {
    if (typeof entry.open !== 'function') {
      return entry;
    }
    return {
      ...entry,
      open: async () => {
        const source = await entry.open();
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            callback(countContent(chunk.length), chunk);
          }
        });
        // `pipeline` passes a failure of the source on to what the archive reads.
        pipeline(source, counter, () => {});
        return counter;
      }
    };
  });
  try {
    for (const entry of counted) {
      if (typeof entry.open !== 'function' && countContent(entry.data?.length || 0))
        throw limitError;
    }
    await writeZip(counted, output);
    await done;
    if (limitError || outputError) throw limitError || outputError;
    return { bytes, contentBytes };
  } catch (error) {
    output.destroy();
    await done;
    throw limitError || error;
  }
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

/** An archive path whose file is rewritten on the way out (library kit). */
const HTML_PATH = /\.html?$/i;

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
 * @throws {ServiceError} 400, 404 or 413 before the first byte is written; the caller lets the
 *   error middleware answer. A payload that fails once the archive has started ends the
 *   response without finishing it (the connection is cut), which a client reports as a failed
 *   download.
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
      throw new ServiceError('BAD_REQUEST', '"artifactIds" must be a list of artifact ids.');
    }
    const byId = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
    const unique = [...new Set(artifactIds)];
    if (unique.some(id => !byId.has(id))) throw new ServiceError('NOT_FOUND', 'Artifact not found');
    selected = unique.map(id => byId.get(id));
  }

  // One reading of the policy for the whole archive: limits and library kit alike.
  const { maxZipFiles, maxZipBytes, libraryKit } = artifactPolicy();
  let planned;
  try {
    planned = planZipEntries(selected, {
      maxFiles: maxZipFiles,
      maxBytes: maxZipBytes,
      fallbackName: downloadName
    });
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    throw error.code === 'empty'
      ? new ServiceError('NOT_FOUND', error.message)
      : new ServiceError('PAYLOAD_TOO_LARGE', error.message, { details: { reason: error.code } });
  }

  // Decided before the first byte goes out: a payload missing now can still
  // be answered with a status, which a half-written archive cannot.
  //
  // Payloads are streamed into the archive one after the other, so none is
  // held in memory. The exception is an HTML file: its library-kit markers
  // become the libraries' source when it leaves iHub, so the file works
  // opened from disk, and for that rewrite it is read whole.
  const entries = [];
  let contentBytes = 0;
  let stored = null;
  for (const item of planned) {
    let entry;
    if (HTML_PATH.test(item.path)) {
      const artifact = await repository.get(scope, item.id);
      if (!artifact) throw new ServiceError('NOT_FOUND', 'Artifact not found');
      const data = withKitLibraries(artifact.data, item.path, libraryKit);
      contentBytes += data.length;
      entry = { path: item.path, data, date: artifact.createdAt };
    } else {
      // One listing of the scope's payloads says which are there.
      stored ??= await repository.storedPayloadIds(scope);
      if (!stored.has(item.id)) throw new ServiceError('NOT_FOUND', 'Artifact not found');
      contentBytes += Number(item.bytes) || 0;
      entry = {
        path: item.path,
        date: item.createdAt,
        open: async () => {
          const artifact = await repository.openRead(scope, item.id);
          // Deleted since the listing: the archive is aborted, not cut short.
          if (!artifact) throw new ServiceError('NOT_FOUND', 'Artifact not found');
          return artifact.stream;
        }
      };
    }
    // The plan counted the stored sizes; the inlined libraries count too.
    if (maxZipBytes > 0 && contentBytes > maxZipBytes) {
      throw new ServiceError(
        'PAYLOAD_TOO_LARGE',
        'The files are too large for one archive once the HTML files carry their libraries.',
        { details: { reason: 'too-large' } }
      );
    }
    entries.push(entry);
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
    // Nothing sent yet (the first payload could not be opened): answered
    // with a status like any failure before the archive started.
    if (!res.headersSent) {
      for (const name of ['Content-Type', 'Content-Disposition']) res.removeHeader(name);
      throw error;
    }
    // Part of the archive is out: the response is cut, never ended, so the
    // client does not take a broken archive for a complete one.
    res.destroy(error);
  }
}
