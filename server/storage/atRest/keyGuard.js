// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether a data directory holds data that was encrypted with the master key,
 * asked by the key service before it creates a new key.
 *
 * A missing key file used to mean "first start": a key was generated. Once
 * chats, files and run history are encrypted with the key, a missing or
 * unreadable key file can also mean "the key volume was not mounted", and a
 * freshly generated key would then start the server on data it can never
 * read, and write new data under a key nobody backed up. So a new key is only
 * created when nothing says that sealed data exists.
 *
 * Evidence, cheapest first:
 * - the state record (`.at-rest.json`) names a master key, in any state: the
 *   switch may be off again while sealed data is still there;
 * - the state record exists and cannot be read;
 * - the key check object of the blob store exists (`blobs/_ihub/keycheck`).
 *
 * Reads with plain `fs`: it runs before storage exists.
 *
 * @module storage/atRest/keyGuard
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AtRestStateError, readAtRestState, recordsSealedData } from './state.js';

/** The key check object of the filesystem blob store, relative to the data directory. */
const KEY_CHECK_PATH = path.join('blobs', '_ihub', 'keycheck');

/**
 * Look for sealed data in data directories.
 *
 * @param {Iterable<string>} dataDirs - Absolute data directories to look at.
 * @returns {Promise<{dataDir: string, reason: 'state-record'|'state-record-unreadable'|'key-check',
 *   keyId: string|null}|null>} The first evidence found, or null.
 *
 * @example
 * await findSealedData(['/srv/ihub/contents/data']);
 * // { dataDir: '/srv/ihub/contents/data', reason: 'state-record', keyId: '1a2b3c4d' }
 */
export async function findSealedData(dataDirs) {
  for (const dataDir of dataDirs) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) continue;
    try {
      const state = await readAtRestState(dataDir);
      if (recordsSealedData(state)) return { dataDir, reason: 'state-record', keyId: state.keyId };
    } catch (error) {
      if (!(error instanceof AtRestStateError)) throw error;
      return { dataDir, reason: 'state-record-unreadable', keyId: null };
    }
    try {
      await fs.stat(path.join(dataDir, KEY_CHECK_PATH));
      return { dataDir, reason: 'key-check', keyId: null };
    } catch {
      // No key check object: nothing was ever encrypted here.
    }
  }
  return null;
}
