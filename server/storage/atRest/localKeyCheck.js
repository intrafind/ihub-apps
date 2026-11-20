// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where the key check object of a data directory is kept:
 * `<data directory>/.at-rest-keycheck`, beside the state record
 * (`.at-rest.json`).
 *
 * The key check object proves that the master key of this installation is the
 * one the stored data was sealed with (`EncryptingBlobStore#verifyKey`). It
 * used to be a blob, `blobs/_ihub/keycheck`. With the blobs in a bucket the
 * local blob tree is something an operator removes after copying it
 * (`npm run storage:copy-blobs`), and the next start then found a state
 * record that names a key and no key check. It now lives outside the blob
 * tree. The bytes are the same encrypted object, bound to the address
 * `_ihub/keycheck`, so a file from the old place is moved as it is: it is
 * read from there once, written to the new place and removed from the old.
 *
 * Reads and writes with plain `fs`, so the key service can look for it before
 * storage exists.
 *
 * @module storage/atRest/localKeyCheck
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../../utils/atomicWrite.js';

/** File name of the key check object, directly in the data directory. */
export const LOCAL_KEY_CHECK_FILE = '.at-rest-keycheck';

/** Where an earlier build kept it, relative to the data directory. */
export const LEGACY_KEY_CHECK_PATH = path.join('blobs', '_ihub', 'keycheck');

/** Namespace and key of the key check object in a blob store. */
const LEGACY_NAMESPACE = '_ihub';
const LEGACY_KEY = 'keycheck';

/**
 * Absolute path of the key check object of a data directory.
 *
 * @param {string} baseDir - The storage provider's base directory.
 * @returns {string}
 */
export function localKeyCheckPath(baseDir) {
  return path.join(baseDir, LOCAL_KEY_CHECK_FILE);
}

/**
 * Whether a data directory has a key check object, at the current or the
 * former place.
 *
 * @param {string} baseDir - The storage provider's base directory.
 * @returns {Promise<boolean>}
 */
export async function localKeyCheckExists(baseDir) {
  for (const candidate of [localKeyCheckPath(baseDir), path.join(baseDir, LEGACY_KEY_CHECK_PATH)]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return true;
    } catch {
      // Not there.
    }
  }
  return false;
}

/**
 * The key check object of a data directory, as the encrypting blob store
 * reads and writes it.
 *
 * @param {Object} options
 * @param {string} options.baseDir - The storage provider's base directory.
 * @param {Object} [options.legacy] - The provider's own blob store, which an
 *   earlier build kept the object in (`get` and `delete`).
 * @returns {{path: string, read: (options?: {migrate?: boolean}) => Promise<Buffer|null>,
 *   write: (data: Buffer) => Promise<void>}}
 *   `read` answers null when there is none. With `migrate` (the default) an
 *   object found at the former place is moved; without it nothing is written.
 *
 * @example
 * const keyCheck = createLocalKeyCheckStore({ baseDir, legacy: provider.blobs });
 * const stored = await keyCheck.read({ migrate: false });
 */
export function createLocalKeyCheckStore({ baseDir, legacy = null }) {
  const file = localKeyCheckPath(baseDir);
  const write = async data => {
    await fs.mkdir(baseDir, { recursive: true });
    await atomicWriteFile(file, data, {});
  };
  return {
    path: file,
    async read({ migrate = true } = {}) {
      try {
        return await fs.readFile(file);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
      if (!legacy) return null;
      const stored = await legacy.get(LEGACY_NAMESPACE, LEGACY_KEY);
      if (!stored) return null;
      if (migrate) {
        // New place first: a crash in between leaves both, never none.
        await write(stored.data);
        await legacy.delete(LEGACY_NAMESPACE, LEGACY_KEY).catch(() => {});
      }
      return stored.data;
    },
    write
  };
}
