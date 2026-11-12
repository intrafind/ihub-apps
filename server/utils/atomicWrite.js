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
 * @param {string|{encoding?: string, mode?: number}} [options] - Encoding, or
 *   `{ encoding, mode }`. `mode` sets the file's permission bits (e.g. `0o600`
 *   for secrets); without it the existing target's mode is kept.
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data, options = 'utf8') {
  const { encoding = 'utf8', mode } =
    typeof options === 'string' ? { encoding: options } : options || {};
  const dir = dirname(filePath);
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dir, `.tmp_${tempSuffix}`);
  const targetMode = await resolveMode(filePath, mode);

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
 * @param {{mode?: number}} [options] - `mode` sets the permission bits (see atomicWriteFile)
 * @returns {Promise<void>}
 */
export async function atomicWriteJSON(filePath, data, options = {}) {
  const jsonData = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, jsonData, { encoding: 'utf8', mode: options?.mode });
}

/**
 * Atomically create a new JSON file, failing if it already exists.
 *
 * Used by admin "create" handlers (agent profiles, etc.) where two
 * concurrent POSTs could otherwise race past an `fs.access` existence
 * check and the second write would silently overwrite the first.
 * Throws an Error whose `.code === 'EEXIST'` when the file already
 * exists; callers should map that to HTTP 409 Conflict.
 *
 * NOTE: `filePath` is trusted — caller-validated path (same contract as
 * `atomicWriteFile`).
 *
 * @param {string} filePath - The target file path (must be caller-validated)
 * @param {any} data - The data to serialize as JSON
 * @returns {Promise<void>}
 */
export async function atomicCreateJSON(filePath, data) {
  const jsonData = JSON.stringify(data, null, 2);
  // `wx` opens the file for writing only if it does not already exist —
  // Node's fs maps it to O_CREAT|O_EXCL so the create-or-fail check is
  // atomic at the filesystem level.
  // lgtm[js/path-injection] -- caller-validated path; see function doc.
  await fs.writeFile(filePath, jsonData, { encoding: 'utf8', flag: 'wx' });
}
