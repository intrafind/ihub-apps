import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file using a temporary file and rename
 * This prevents data corruption from partial writes
 *
 * NOTE: `filePath` is trusted by this utility. Callers are responsible for
 * validating any user-derived component (e.g. via `validateIdForPath()` +
 * `resolveAndValidatePath()` from `utils/pathSecurity.js`) before passing
 * it in. CodeQL flags the fs operations below because the data flow from
 * `req.params.*` reaches this function; the `lgtm` annotations suppress
 * those false-positive findings.
 *
 * @param {string} filePath - The target file path (must be caller-validated)
 * @param {string} data - The data to write
 * @param {string} encoding - File encoding (default: 'utf8')
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data, encoding = 'utf8') {
  const dir = dirname(filePath);
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dir, `.tmp_${tempSuffix}`);

  try {
    // Write to temporary file first
    // lgtm[js/path-injection] -- caller-validated path; see function doc.
    await fs.writeFile(tempPath, data, encoding);

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
}

/**
 * Atomically write JSON data to a file with pretty formatting
 *
 * @param {string} filePath - The target file path
 * @param {any} data - The data to serialize as JSON
 * @returns {Promise<void>}
 */
export async function atomicWriteJSON(filePath, data) {
  const jsonData = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, jsonData, 'utf8');
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
