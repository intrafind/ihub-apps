// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Importing files into a project: a file that becomes one document, or a ZIP
 * archive that becomes one document per file in it.
 *
 * What comes in is what `POST …/items/_import` received: an uploaded file, or
 * the bytes of a chat artifact the caller may read ("Copy to project"). Every
 * file, and every entry of an archive, goes through `ProjectService.addItem`
 * as an upload, so the type check, the malware scan, the extraction, the
 * encryption, the original (when `platform.uploads.storageMode` keeps it) and
 * the project's limits all apply exactly as for a file uploaded by hand.
 *
 * **Archives.** Only the archive's own files are unpacked: a nested archive,
 * an image or any other type a project does not take is reported in
 * `skipped`, never stored. The sizes an archive declares are not trusted:
 * every entry is inflated against a hard ceiling (the per-file limit, and
 * what is left of the project's room), so a "zip bomb" stops at the limit.
 * Folder entries and the metadata macOS adds (`__MACOSX/`, `.DS_Store`) are
 * passed over silently.
 *
 * @module services/projects/itemImport
 */
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { acceptedTypeOf, sniffBytes } from './extractText.js';
import { ProjectError } from './projectErrors.js';

/** ZIP media types browsers and stores send for an archive. */
const ZIP_MIMES = new Set(['application/zip', 'application/x-zip-compressed']);

/** Entries one archive may have, files and folders together. */
export const MAX_ARCHIVE_ENTRIES = 2000;

/** Longest item name; an entry's path inside the archive is its name. */
const MAX_NAME_CHARS = 300;

const DEFLATE = '\u0008\u0000';
const STORE = '\u0000\u0000';

/**
 * Whether these bytes are a ZIP archive to unpack, rather than an Office or
 * OpenDocument file (which are ZIP packages too, and are documents).
 *
 * @param {{name?: string, contentType?: string, bytes: Buffer}} file
 * @returns {boolean}
 */
export function isZipArchive({ name, contentType, bytes }) {
  if (sniffBytes(bytes) !== 'zip') return false;
  // A package the extractors read (`.docx`, `.xlsx`, `.odt`, …) is a document.
  const accepted = acceptedTypeOf({ contentType, name });
  if (accepted) return false;
  const extension = path.extname(String(name || '')).toLowerCase();
  const declared = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return extension === '.zip' || ZIP_MIMES.has(declared);
}

/** Entries that are an archiver's bookkeeping, not content. */
function isNoise(entryName) {
  const parts = entryName.split('/');
  const base = parts[parts.length - 1];
  return parts.includes('__MACOSX') || base === '.DS_Store' || base === 'Thumbs.db' || base === '';
}

/**
 * The bytes of one entry, inflated with a hard ceiling.
 *
 * @returns {Buffer|null} null when the entry is larger than `maxBytes`.
 * @throws {ProjectError} `UNSUPPORTED_TYPE` for a compression method other
 *   than deflate or store, or a damaged entry.
 */
function inflateEntry(entry, maxBytes) {
  const data = entry._data;
  const magic = data?.compression?.magic;
  const raw = data?.compressedContent;
  if (!raw || (magic !== DEFLATE && magic !== STORE)) {
    throw new ProjectError(
      'UNSUPPORTED_TYPE',
      `${entry.name} uses a compression method that cannot be read`
    );
  }
  if (magic === STORE) return raw.length > maxBytes ? null : Buffer.from(raw);
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, maxBytes) });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') return null;
    throw new ProjectError('UNSUPPORTED_TYPE', `${entry.name} is damaged`);
  }
}

/**
 * Unpack a ZIP archive into the files a project could take.
 *
 * @param {Buffer} bytes
 * @param {Object} limits
 * @param {number} limits.maxFiles - Files to return at most (the room left in the project).
 * @param {number} limits.maxFileBytes - Largest file, unpacked.
 * @param {number} limits.maxTotalBytes - All files together, unpacked (the room left).
 * @returns {Promise<{files: Array<{name: string, fileName: string, bytes: Buffer}>,
 *   skipped: Array<{name: string, code: string, message: string}>}>}
 * @throws {ProjectError} `UNSUPPORTED_TYPE` for an archive that cannot be read
 *   (damaged, encrypted, too many entries).
 */
export async function unpackZip(bytes, { maxFiles, maxFileBytes, maxTotalBytes }) {
  let archive;
  try {
    archive = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch (error) {
    throw new ProjectError(
      'UNSUPPORTED_TYPE',
      /encrypt/i.test(error?.message || '')
        ? 'The ZIP archive is encrypted'
        : 'The ZIP archive is damaged or not a ZIP archive'
    );
  }
  const entries = Object.values(archive.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new ProjectError(
      'UNSUPPORTED_TYPE',
      `The ZIP archive has more than ${MAX_ARCHIVE_ENTRIES} entries`
    );
  }
  const files = [];
  const skipped = [];
  let total = 0;
  const skip = (name, code, message) => skipped.push({ name, code, message });
  for (const entry of entries) {
    if (entry.dir || isNoise(entry.name)) continue;
    const name = entry.name.replace(/^\/+/, '').slice(0, MAX_NAME_CHARS);
    const fileName = path.posix.basename(entry.name);
    if (files.length >= maxFiles) {
      skip(name, 'QUOTA_FILES', 'The project has no room for more documents');
      continue;
    }
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.zip')) {
      skip(name, 'UNSUPPORTED_TYPE', 'An archive inside an archive is not unpacked');
      continue;
    }
    if (!acceptedTypeOf({ name: fileName })) {
      skip(name, 'UNSUPPORTED_TYPE', 'Projects do not take files of this type');
      continue;
    }
    const room = Math.min(maxFileBytes, Math.max(0, maxTotalBytes - total));
    let data;
    try {
      data = inflateEntry(entry, room);
    } catch (error) {
      skip(name, error.code || 'UNSUPPORTED_TYPE', error.message);
      continue;
    }
    if (!data) {
      skip(
        name,
        room < maxFileBytes ? 'QUOTA_PROJECT_BYTES' : 'QUOTA_FILE_BYTES',
        room < maxFileBytes
          ? 'The project has no room for this file'
          : 'The file is larger than a project document may be'
      );
      continue;
    }
    total += data.length;
    files.push({ name, fileName, bytes: data });
  }
  return { files, skipped };
}

/** Errors that refuse one file without stopping the others. */
const PER_FILE_CODES = new Set([
  'UNSUPPORTED_TYPE',
  'QUOTA_FILES',
  'QUOTA_FILE_BYTES',
  'QUOTA_PROJECT_BYTES',
  'MALWARE_DETECTED',
  'EXTRACTION_FAILED',
  'NO_TEXT'
]);

/**
 * Import a file into a project: as one document, or, for a ZIP archive, as
 * one document per file it holds.
 *
 * @param {import('./ProjectService.js').ProjectService} service
 * @param {Object} project - The target project, as loaded for the request.
 * @param {{bytes: Buffer, name: string, contentType?: string}} file
 * @param {Object} options
 * @param {Object} options.user
 * @param {Function} [options.authorize]
 * @param {boolean} [options.pinned]
 * @param {Object} [options.from] - Where the file came from, recorded on every
 *   item (`provenance.from`): `{ type: 'chat', chatId, appId, artifactId }`.
 * @param {{maxFiles: number, maxFileBytes: number, maxProjectBytes: number}} options.limits
 * @returns {Promise<{items: Object[], skipped: Array<{name: string, code: string, message: string}>}>}
 * @throws {ProjectError} When nothing could be added: the one file's own
 *   refusal, or `UNSUPPORTED_TYPE` with `details.skipped` for an archive.
 */
export async function importFile(
  service,
  project,
  file,
  { user, authorize, pinned = false, from = null, limits }
) {
  const archive = isZipArchive(file);
  let candidates;
  let skipped = [];
  if (archive) {
    const used = Number(project?.usage?.bytes) || 0;
    const count = (project?.items || []).length;
    ({ files: candidates, skipped } = await unpackZip(file.bytes, {
      maxFiles: limits.maxFiles > 0 ? Math.max(0, limits.maxFiles - count) : Infinity,
      maxFileBytes: limits.maxFileBytes > 0 ? limits.maxFileBytes : Infinity,
      maxTotalBytes: limits.maxProjectBytes > 0 ? limits.maxProjectBytes - used : Infinity
    }));
  } else {
    candidates = [
      { name: file.name, fileName: file.name, bytes: file.bytes, contentType: file.contentType }
    ];
  }

  const items = [];
  for (const candidate of candidates) {
    const provenanceFrom = {
      ...(from || {}),
      ...(archive ? { archive: String(file.name || 'archive.zip').slice(0, MAX_NAME_CHARS) } : {})
    };
    try {
      // The type and the bytes are checked here as for an upload; `addItem`
      // and the pipeline check them again.
      if (
        !acceptedTypeOf({ contentType: candidate.contentType, name: candidate.fileName }) ||
        sniffBytes(candidate.bytes) === 'refused'
      ) {
        throw new ProjectError(
          'UNSUPPORTED_TYPE',
          `${candidate.fileName || 'The file'} is an image, media, archive or binary file, or a type projects do not take`
        );
      }
      const { item } = await service.addItem(
        project.id,
        {
          kind: 'upload',
          ref: {},
          name: candidate.name,
          pinned: pinned === true,
          ...(Object.keys(provenanceFrom).length ? { from: provenanceFrom } : {}),
          file: {
            buffer: candidate.bytes,
            name: candidate.fileName,
            contentType: candidate.contentType
          }
        },
        { user, authorize, wait: false }
      );
      items.push(item);
    } catch (error) {
      if (!archive || !PER_FILE_CODES.has(error?.code)) throw error;
      skipped.push({ name: candidate.name, code: error.code, message: error.message });
    }
  }
  if (archive && items.length === 0) {
    throw new ProjectError('UNSUPPORTED_TYPE', 'Nothing in the ZIP archive could be added', {
      skipped
    });
  }
  return { items, skipped };
}
