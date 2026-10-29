// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Hardened extraction of release archives (`.tar.gz` and `.zip`).
 *
 * An update archive is code the server is about to run, and with "install from
 * file" an admin supplies it, so nothing in it is trusted until it has been
 * checked entry by entry. This module reads both formats itself — tar through
 * Node's gunzip and a small header parser, zip through the bundled `yauzl` —
 * instead of shelling out to `tar`: `tar -tzf` lists names only (no symlink,
 * hardlink or device information), extracting as root keeps the archive's
 * owners, and `tar.exe` cannot read zips on Windows Server 2016.
 *
 * Every entry is rejected unless it is a regular file or a directory with a
 * plain relative name. Rejected: absolute paths, `..` segments, drive letters,
 * `:` (NTFS alternate streams), NUL, symlinks, hardlinks, devices and FIFOs,
 * duplicate names and names that differ only by case (Windows and macOS
 * install directories are case-insensitive). Entry count, total size and the
 * compression ratio are capped (archive bombs). The caller decides which
 * top-level names may appear.
 *
 * @module update/archive
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import yauzl from 'yauzl';

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  /** A release has ~50k files today (mostly server/node_modules). */
  maxEntries: 250_000,
  /** Uncompressed size of the whole archive. */
  maxTotalBytes: 4 * 1024 ** 3,
  /** Uncompressed size / archive size. Releases compress about 3:1. */
  maxCompressionRatio: 50
});

/** An archive that must not be installed. The message is safe to show to the admin. */
export class ArchiveRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveRejectedError';
  }
}

/**
 * Normalize an archive entry name to a relative `/`-separated path.
 *
 * `tar -czf … .` (how the release workflow packs) prefixes every entry with
 * `./`; that prefix is dropped. Zip archives written on Windows may use `\`.
 *
 * @param {string} rawName
 * @param {{ backslashIsSeparator?: boolean }} [options]
 * @returns {string} '' for the archive root itself
 * @throws {ArchiveRejectedError}
 */
export function normalizeEntryName(rawName, { backslashIsSeparator = false } = {}) {
  let name = String(rawName);
  if (name.includes('\0')) throw new ArchiveRejectedError('Archive entry name contains NUL');
  if (name.includes('\\')) {
    if (!backslashIsSeparator) {
      throw new ArchiveRejectedError(`Archive entry name contains a backslash: ${printable(name)}`);
    }
    name = name.replace(/\\/g, '/');
  }
  if (name.startsWith('/')) {
    throw new ArchiveRejectedError(`Archive contains an absolute path: ${printable(name)}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new ArchiveRejectedError(`Archive contains a drive-letter path: ${printable(name)}`);
  }
  if (name.includes(':')) {
    throw new ArchiveRejectedError(`Archive entry name contains ':': ${printable(name)}`);
  }
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new ArchiveRejectedError(`Archive contains a path outside its root: ${printable(name)}`);
  }
  return segments.join('/');
}

/** An entry name shortened and stripped of control characters, for messages. */
function printable(name) {
  const clean = String(name).replace(/[\x00-\x1f\x7f]/g, '?');
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/** macOS `tar` adds AppleDouble `._name` entries for extended attributes. */
function isAppleDouble(relPath) {
  return path.posix.basename(relPath).startsWith('._');
}

/**
 * Tracks what has been extracted and enforces the limits and naming rules
 * that apply to both formats.
 */
class ExtractionGuard {
  constructor({ destDir, classifyTopLevel, limits, archiveSize }) {
    this.destDir = path.resolve(destDir);
    this.classifyTopLevel = classifyTopLevel;
    this.limits = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
    // The ratio cap only applies above a small floor, where tar headers alone
    // can compress better than 50:1.
    this.maxBytes = Math.min(
      this.limits.maxTotalBytes,
      Math.max(archiveSize * this.limits.maxCompressionRatio, 16 * 1024 * 1024)
    );
    this.entryCount = 0;
    this.totalBytes = 0;
    this.seen = new Set();
    this.files = new Map();
    this.ignored = new Set();
  }

  countBytes(n) {
    this.totalBytes += n;
    if (this.totalBytes > this.maxBytes) {
      throw new ArchiveRejectedError(
        `Archive expands to more than ${Math.round(this.maxBytes / 1024 ** 2)} MB; refusing to extract it`
      );
    }
  }

  /**
   * Decide what to do with an entry.
   * @returns {{ action: 'skip' } | { action: 'dir'|'file', relPath: string, target: string }}
   */
  admit(relPath, kind) {
    this.entryCount++;
    if (this.entryCount > this.limits.maxEntries) {
      throw new ArchiveRejectedError(`Archive has more than ${this.limits.maxEntries} entries`);
    }
    if (relPath === '') return { action: 'skip' };
    if (isAppleDouble(relPath)) return { action: 'skip' };

    const key = relPath.toLowerCase();
    if (this.seen.has(key)) {
      throw new ArchiveRejectedError(
        `Archive contains a duplicate or case-colliding entry: ${printable(relPath)}`
      );
    }
    this.seen.add(key);

    const topLevel = relPath.split('/')[0];
    const verdict = this.classifyTopLevel(topLevel, { kind, isTopLevel: topLevel === relPath });
    if (verdict === 'reject') {
      throw new ArchiveRejectedError(
        `Archive contains an unexpected entry: ${printable(topLevel)}`
      );
    }
    if (verdict === 'ignore') {
      this.ignored.add(topLevel);
      return { action: 'skip' };
    }

    const target = path.resolve(this.destDir, ...relPath.split('/'));
    if (!target.startsWith(this.destDir + path.sep)) {
      throw new ArchiveRejectedError(
        `Archive entry escapes the extraction directory: ${printable(relPath)}`
      );
    }
    return { action: kind, relPath, target };
  }

  async writeFile(admitted, source, mode, size) {
    await fs.mkdir(path.dirname(admitted.target), { recursive: true });
    const hash = createHash('sha256');
    let written = 0;
    const guard = this;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length;
        hash.update(chunk);
        try {
          guard.countBytes(chunk.length);
        } catch (error) {
          callback(error);
          return;
        }
        callback(null, chunk);
      }
    });
    // 'wx': a second entry for the same path can never overwrite the first.
    await pipeline(source, meter, createWriteStream(admitted.target, { flags: 'wx', mode }));
    if (size !== undefined && written !== size) {
      throw new ArchiveRejectedError(`Archive entry ${printable(admitted.relPath)} is truncated`);
    }
    this.files.set(admitted.relPath, { size: written, sha256: hash.digest('hex') });
  }

  result() {
    return {
      files: this.files,
      ignored: [...this.ignored],
      entryCount: this.entryCount,
      totalBytes: this.totalBytes
    };
  }
}

/** Unix permission bits for an extracted file: executable or not, nothing else. */
function fileMode(archivedMode) {
  return archivedMode & 0o111 ? 0o755 : 0o644;
}

// ---------------------------------------------------------------- tar ----

const BLOCK = 512;

/** Pulls exact byte counts out of an async iterable of Buffers. */
class ByteReader {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async fill(n) {
    while (this.buffer.length < n && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) this.ended = true;
      else this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    }
  }

  async read(n) {
    await this.fill(n);
    if (this.buffer.length < n) throw new ArchiveRejectedError('Archive is truncated');
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** The next `n` bytes as a stream of chunks, without holding them all in memory. */
  async *chunks(n) {
    let remaining = n;
    while (remaining > 0) {
      if (this.buffer.length === 0) {
        await this.fill(1);
        if (this.buffer.length === 0) throw new ArchiveRejectedError('Archive is truncated');
      }
      const take = Math.min(remaining, this.buffer.length);
      const chunk = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      remaining -= take;
      yield chunk;
    }
  }

  async skip(n) {
    for await (const _chunk of this.chunks(n)) {
      // discard
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}

function cString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(buf, start, length) {
  const field = buf.subarray(start, start + length);
  if (field[0] & 0x80) {
    // GNU base-256 for sizes over 8 GB
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    return value;
  }
  const text = cString(buf, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveRejectedError('Archive has a corrupt tar header');
  return Number.parseInt(text, 8);
}

function verifyHeaderChecksum(header) {
  const expected = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (sum !== expected) throw new ArchiveRejectedError('Archive has a corrupt tar header');
}

function parsePax(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
}

const padding = size => (BLOCK - (size % BLOCK)) % BLOCK;

/** Metadata blocks (pax and GNU long names) are small; anything larger is hostile. */
const MAX_METADATA_BYTES = 1024 * 1024;

async function extractTarGz(archivePath, guard) {
  const gunzip = createGunzip();
  const source = createReadStream(archivePath);
  source.on('error', error => gunzip.destroy(error));
  source.pipe(gunzip);
  // Count decompressed bytes, headers included, so a bomb of empty headers is
  // capped as well.
  const counted = (async function* () {
    for await (const chunk of gunzip) {
      guard.countBytes(chunk.length);
      yield chunk;
    }
  })();
  const reader = new ByteReader(counted);

  let paxNext = {};
  let longName = null;
  try {
    for (;;) {
      await reader.fill(BLOCK);
      if (reader.buffer.length < BLOCK) {
        throw new ArchiveRejectedError('Archive is truncated (no end-of-archive marker)');
      }
      const header = await reader.read(BLOCK);
      if (header.every(byte => byte === 0)) break;
      verifyHeaderChecksum(header);

      const type = String.fromCharCode(header[156] || 0x30);
      let size = octal(header, 124, 12);

      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > MAX_METADATA_BYTES)
          throw new ArchiveRejectedError('Archive has an oversized tar header');
        const data = await reader.read(size);
        await reader.read(padding(size));
        if (type === 'x') paxNext = parsePax(data);
        else if (type === 'L') longName = cString(data, 0, data.length);
        // 'g' (global pax) and 'K' (long link name) carry nothing we use.
        continue;
      }

      let name = cString(header, 0, 100);
      if (cString(header, 257, 5) === 'ustar') {
        const prefix = cString(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      if (longName !== null) name = longName;
      if (paxNext.path !== undefined) name = paxNext.path;
      if (paxNext.size !== undefined) size = Number.parseInt(paxNext.size, 10);
      const mode = octal(header, 100, 8);
      paxNext = {};
      longName = null;

      const relPath = normalizeEntryName(name);
      let kind;
      if (type === '0' || type === '\0' || type === '7') kind = 'file';
      else if (type === '5') kind = 'dir';
      else if (type === '1')
        throw new ArchiveRejectedError(`Archive contains a hard link: ${printable(relPath)}`);
      else if (type === '2')
        throw new ArchiveRejectedError(`Archive contains a symbolic link: ${printable(relPath)}`);
      else {
        throw new ArchiveRejectedError(
          `Archive contains an entry that is not a file or directory: ${printable(relPath)}`
        );
      }

      const admitted = guard.admit(relPath, kind);
      if (admitted.action === 'dir') {
        await fs.mkdir(admitted.target, { recursive: true });
      } else if (admitted.action === 'file') {
        await guard.writeFile(admitted, reader.chunks(size), fileMode(mode), size);
      } else if (size > 0) {
        await reader.skip(size);
      }
      await reader.read(padding(size));
    }
  } finally {
    await reader.close();
    source.destroy();
  }
}

// ---------------------------------------------------------------- zip ----

function openZip(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      // Names are decoded and validated here, not by yauzl, which would turn
      // `\` into `/` silently.
      { lazyEntries: true, autoClose: true, decodeStrings: false, validateEntrySizes: true },
      (error, zipfile) =>
        error
          ? reject(new ArchiveRejectedError(`Archive is not a valid zip: ${error.message}`))
          : resolve(zipfile)
    );
  });
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

async function extractZip(archivePath, guard) {
  const zipfile = await openZip(archivePath);
  if (zipfile.entryCount > guard.limits.maxEntries) {
    zipfile.close();
    throw new ArchiveRejectedError(`Archive has more than ${guard.limits.maxEntries} entries`);
  }

  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      try {
        zipfile.close();
      } catch {
        // ignore
      }
      reject(error);
    };

    zipfile.on('error', error =>
      fail(new ArchiveRejectedError(`Archive is corrupt: ${error.message}`))
    );
    zipfile.on('end', () => {
      if (!failed) resolve();
    });
    zipfile.on('entry', entry => {
      (async () => {
        // Bit 11: the name is UTF-8; otherwise CP437, which is ASCII for every name we ship.
        const rawName = entry.fileName.toString(
          entry.generalPurposeBitFlag & 0x800 ? 'utf8' : 'latin1'
        );
        const relPath = normalizeEntryName(rawName, { backslashIsSeparator: true });
        const unixType = (entry.externalFileAttributes >>> 16) & S_IFMT;
        const isDir = rawName.endsWith('/') || rawName.endsWith('\\') || unixType === S_IFDIR;
        if (unixType === S_IFLNK) {
          throw new ArchiveRejectedError(`Archive contains a symbolic link: ${printable(relPath)}`);
        }
        if (unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR) {
          throw new ArchiveRejectedError(
            `Archive contains an entry that is not a file or directory: ${printable(relPath)}`
          );
        }
        if (entry.isEncrypted()) {
          throw new ArchiveRejectedError(
            `Archive contains an encrypted entry: ${printable(relPath)}`
          );
        }

        const admitted = guard.admit(relPath, isDir ? 'dir' : 'file');
        if (admitted.action === 'dir') {
          await fs.mkdir(admitted.target, { recursive: true });
        } else if (admitted.action === 'file') {
          const stream = await new Promise((res, rej) =>
            zipfile.openReadStream(entry, (error, s) => (error ? rej(error) : res(s)))
          );
          const mode = (entry.externalFileAttributes >>> 16) & 0o777;
          await guard.writeFile(admitted, stream, fileMode(mode), entry.uncompressedSize);
        }
        zipfile.readEntry();
      })().catch(fail);
    });
    zipfile.readEntry();
  });
}

// ------------------------------------------------------------- public ----

/**
 * Extract an archive into `destDir` (created, must be empty or absent).
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @param {Object} options
 * @param {'tar.gz'|'zip'} options.format
 * @param {(topLevel: string, info: { kind: string, isTopLevel: boolean }) => 'extract'|'ignore'|'reject'} options.classifyTopLevel
 * @param {Partial<typeof DEFAULT_ARCHIVE_LIMITS>} [options.limits]
 * @returns {Promise<{ files: Map<string, { size: number, sha256: string }>, ignored: string[], entryCount: number, totalBytes: number }>}
 * @throws {ArchiveRejectedError} for an archive that must not be installed;
 *   `destDir` is removed again on any failure
 */
export async function extractArchive(archivePath, destDir, { format, classifyTopLevel, limits }) {
  const { size: archiveSize } = await fs.stat(archivePath);
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });
  const guard = new ExtractionGuard({ destDir, classifyTopLevel, limits, archiveSize });
  try {
    if (format === 'zip') await extractZip(archivePath, guard);
    else if (format === 'tar.gz') await extractTarGz(archivePath, guard);
    else throw new ArchiveRejectedError(`Unsupported archive format: ${format}`);
  } catch (error) {
    await fs.rm(destDir, { recursive: true, force: true });
    if (error instanceof ArchiveRejectedError) throw error;
    if (error?.code === 'Z_DATA_ERROR' || error?.code === 'Z_BUF_ERROR' || error?.errno === -3) {
      throw new ArchiveRejectedError('Archive is corrupt or not a gzip file');
    }
    if (/unexpected end of file/i.test(error?.message || '')) {
      throw new ArchiveRejectedError('Archive is truncated');
    }
    throw error;
  }
  return guard.result();
}

/**
 * Decode a `*.base64.txt` release asset (published for customers whose
 * download filters block archives) into the archive it encodes.
 *
 * @param {string} sourcePath
 * @param {string} destPath
 */
export async function decodeBase64File(sourcePath, destPath) {
  let carry = '';
  const decoder = new Transform({
    transform(chunk, _encoding, callback) {
      const text = carry + chunk.toString('ascii').replace(/[\s]/g, '');
      if (/[^A-Za-z0-9+/=]/.test(text)) {
        callback(new ArchiveRejectedError('The .base64.txt file is not valid base64'));
        return;
      }
      const usable = text.length - (text.length % 4);
      carry = text.slice(usable);
      callback(null, Buffer.from(text.slice(0, usable), 'base64'));
    },
    flush(callback) {
      if (carry.length > 0) {
        callback(new ArchiveRejectedError('The .base64.txt file is truncated'));
        return;
      }
      callback();
    }
  });
  await pipeline(createReadStream(sourcePath), decoder, createWriteStream(destPath));
}

/**
 * SHA-256 of a file, hex.
 * @param {string|import('node:fs').promises.FileHandle} fileOrHandle
 */
export async function sha256File(fileOrHandle) {
  const hash = createHash('sha256');
  const stream =
    typeof fileOrHandle === 'string'
      ? createReadStream(fileOrHandle)
      : fileOrHandle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
