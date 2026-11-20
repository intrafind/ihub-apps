// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the tests of encryption at rest on the filesystem provider:
 * a provider in a given encryption mode over fixed test keys, and a search of
 * a data directory for content that must not be readable.
 *
 * @module tests/support/atRestTestSupport
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import * as keyModule from '../../crypto/KeyProvider.js';
import { MASTER_KEY_A, fixedKeys } from './blobTestSupport.js';

/**
 * The key module over a fixed master key, as a provider loads it.
 *
 * @param {Object} [options] - `master`, `previous`, `source`; see `fixedKeys`.
 * @returns {Object}
 */
export function testKeys(options = {}) {
  return fixedKeys(keyModule, { master: MASTER_KEY_A, ...options });
}

/**
 * A filesystem provider over `baseDir` in one encryption mode. Not initialized.
 *
 * @param {string} baseDir
 * @param {'off'|'converting'|'enforced'|'auto'} mode
 * @param {Object} [options]
 * @param {Object} [options.keys] - Key module; a fixed test key by default.
 * @param {Object} [options.config] - More provider configuration.
 * @returns {FilesystemStorageProvider}
 */
export function providerInMode(baseDir, mode, { keys = testKeys(), config = {} } = {}) {
  return new FilesystemStorageProvider({
    baseDir,
    flushIntervalMs: 25,
    fenceSweepIntervalMs: 0,
    ...config,
    encryption: { mode, loadKeys: async () => keys }
  });
}

/**
 * Every regular file under a directory.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} Absolute paths, sorted.
 */
export async function filesUnder(dir) {
  const found = [];
  const walk = async current => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) found.push(absolute);
    }
  };
  await walk(dir);
  return found.sort();
}

/**
 * The files under a directory whose bytes or whose path show one of the
 * needles: as UTF-8, as UTF-16LE, as base64 or as hex.
 *
 * @param {string} dir
 * @param {string[]} needles - Texts that must not be readable.
 * @returns {Promise<Array<{file: string, needle: string, form: string}>>}
 */
export async function findReadable(dir, needles) {
  const forms = needle => ({
    'UTF-8': Buffer.from(needle, 'utf8'),
    'UTF-16LE': Buffer.from(needle, 'utf16le'),
    base64: Buffer.from(Buffer.from(needle).toString('base64').slice(0, -4)),
    hex: Buffer.from(Buffer.from(needle).toString('hex'))
  });
  const hits = [];
  for (const file of await filesUnder(dir)) {
    const stored = await fs.readFile(file);
    for (const needle of needles) {
      if (file.includes(needle)) hits.push({ file, needle, form: 'path' });
      for (const [form, bytes] of Object.entries(forms(needle))) {
        if (stored.includes(bytes)) hits.push({ file, needle, form });
      }
    }
  }
  return hits;
}
