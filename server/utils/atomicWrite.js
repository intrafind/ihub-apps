// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Permission bits to give the replacement file.
 *
 * An explicit `mode` wins. Otherwise the target's current mode is carried over,
 * because a rename swaps the inode and the temp file would otherwise come up
 * with the process umask's default — a `0600` secrets file silently turning
 * `0644` on its first save. A target that does not exist yet gets the default.
 */
async function resolveMode(filePath, mode) {
  if (Number.isInteger(mode)) return mode & 0o7777;
  try {
    // lgtm[js/path-injection] -- caller-validated path; see atomicWriteFile.
    return (await fs.stat(filePath)).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Run `write`; when it fails because `dir` does not exist, create `dir` and run
 * it once more. Saves a `mkdir` on every write to a directory that is almost
 * always there already. `write` must be safe to repeat after an ENOENT.
 *
 * @template T
 * @param {string} dir - Directory `write` puts its file in
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
export async function writeInDirectory(dir, write) {
  try {
    return await write();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // lgtm[js/path-injection] -- caller-validated path; see atomicWriteFile.
    await fs.mkdir(dir, { recursive: true });
    return write();
  }
}

/** Flush the directory entry created by a rename; best effort where unsupported. */
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Windows, and a few network filesystems, cannot fsync a directory.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Atomically write data to a file using a temporary file and rename
 * This prevents data corruption from partial writes
 *
 * The temp file is fsynced before the rename and the directory after it, so a
 * crash or power loss leaves either the old file or the new one — never a
 * renamed-but-empty file. That costs two fsyncs per write; every caller here is
 * an admin or state save rather than a per-request hot path, and a small file's
 * fsync is in the millisecond range on SSDs.
 *
 * NOTE: `filePath` is trusted by this utility. Callers are responsible for
 * validating any user-derived component (e.g. via `assertValidId()` +
 * `resolveAndValidatePath()` from `utils/pathSecurity.js`) before passing
 * it in. CodeQL flags the fs operations below because the data flow from
 * `req.params.*` reaches this function; the `lgtm` annotations suppress
 * those false-positive findings.
 *
 * @param {string} filePath - The target file path (must be caller-validated)
 * @param {string|Buffer} data - The data to write
 * @param {string|{encoding?: string, mode?: number, keepMode?: boolean}} [options] -
 *   Encoding, or `{ encoding, mode, keepMode }`. `mode` sets the file's
 *   permission bits (e.g. `0o600` for secrets); without it the existing
 *   target's mode is kept, unless `keepMode: false`: then the file gets the
 *   default mode a new file gets, and the `stat` and `fchmod` are skipped (for
 *   files that are always written with the default mode, like store documents).
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data, options = 'utf8') {
  const {
    encoding = 'utf8',
    mode,
    keepMode = true
  } = typeof options === 'string' ? { encoding: options } : options || {};
  const dir = dirname(filePath);
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dir, `.tmp_${tempSuffix}`);
  const targetMode =
    keepMode || Number.isInteger(mode) ? await resolveMode(filePath, mode) : undefined;

  try {
    // Write to temporary file first
    // lgtm[js/path-injection] -- caller-validated path; see function doc.
    const handle = await fs.open(tempPath, 'wx', targetMode ?? 0o666);
    try {
      await handle.writeFile(data, encoding);
      // The open mode is filtered by the umask; set the bits exactly.
      if (targetMode !== undefined) await handle.chmod(targetMode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Atomically rename temp file to target file
    // lgtm[js/path-injection] -- caller-validated path; see function doc.
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      // lgtm[js/path-injection] -- caller-validated path; see function doc.
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
  await syncDirectory(dir);
}

/**
 * Atomically write JSON data to a file with pretty formatting
 *
 * @param {string} filePath - The target file path
 * @param {any} data - The data to serialize as JSON
 * @param {{mode?: number, keepMode?: boolean}} [options] - Permission bits (see atomicWriteFile)
 * @returns {Promise<void>}
 */
export async function atomicWriteJSON(filePath, data, options = {}) {
  const jsonData = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, jsonData, {
    encoding: 'utf8',
    mode: options?.mode,
    keepMode: options?.keepMode
  });
}

/**
 * Atomically create a new JSON file, failing if it already exists.
 *
 * Used by admin "create" handlers (agent profiles, etc.) where two
 * concurrent POSTs could otherwise race past an `fs.access` existence
 * check and the second write would silently overwrite the first, and by the
 * document store for a create-only `put`. Throws an Error whose
 * `.code === 'EEXIST'` when the file already exists; callers should map that
 * to HTTP 409 Conflict.
 *
 * The content is written to a temp file and fsynced first, then hard-linked
 * onto the target: `link` fails with EEXIST when the target exists, so it is
 * the same create-or-fail as `O_EXCL`, but the name appears with its whole
 * content. Writing through an `O_EXCL` handle on the target itself left a
 * moment in which the file existed empty or half-written, and a reader that
 * caught it (a second worker's `get` of a chat being created) failed on
 * "Unexpected end of JSON input".
 *
 * NOTE: `filePath` is trusted — caller-validated path (same contract as
 * `atomicWriteFile`).
 *
 * @param {string} filePath - The target file path (must be caller-validated)
 * @param {any} data - The data to serialize as JSON
 * @returns {Promise<void>}
 */
/** `link` errors of a filesystem that has no hard links. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']);

/** Hard links of `file`, 0 when it cannot be stat'ed. */
async function linkCount(file) {
  // lgtm[js/path-injection] -- the temp file of a caller-validated path.
  return (await fs.stat(file).catch(() => null))?.nlink ?? 0;
}

export async function atomicCreateJSON(filePath, data) {
  const jsonData = JSON.stringify(data, null, 2);
  const dir = dirname(filePath);
  const tempPath = join(dir, `.tmp_${randomBytes(8).toString('hex')}`);
  // lgtm[js/path-injection] -- caller-validated path; see function doc.
  const handle = await fs.open(tempPath, 'wx');
  try {
    try {
      await handle.writeFile(jsonData, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // lgtm[js/path-injection] -- caller-validated path; see function doc.
      await fs.link(tempPath, filePath);
    } catch (error) {
      // NFS: the link was made, its reply lost, and the retried request
      // answered EEXIST. The temp file's second name is the target: ours.
      const linkedAfterAll = error.code === 'EEXIST' && (await linkCount(tempPath)) === 2;
      if (!linkedAfterAll) {
        if (!NO_HARD_LINKS.has(error.code)) throw error;
        // A filesystem without hard links (some network and FUSE mounts): an
        // exclusive create of the target, briefly visible half-written.
        // lgtm[js/path-injection] -- caller-validated path; see function doc.
        await fs.writeFile(filePath, jsonData, { encoding: 'utf8', flag: 'wx' });
      }
    }
  } finally {
    // lgtm[js/path-injection] -- caller-validated path; see function doc.
    await fs.unlink(tempPath).catch(() => {});
  }
  await syncDirectory(dir);
}
