// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The key-prefix index the filesystem document and blob stores keep for the
 * namespaces in `KEY_PREFIX_SEGMENTS` (`storage/namespaces.js`).
 *
 * Layout, one empty marker file per key, named by the key:
 *
 *   <base>/<ns>/.prefixes/<partition>/<key>          documents
 *   <base>/blobs/<ns>/.prefixes/<partition>/<key>    blobs
 *
 * `<partition>` is the key up to its N-th `__` ({@link prefixPartition}). A
 * listing whose prefix holds N complete `__` reads the one partition directory
 * instead of the whole namespace directory — the files of one chat out of
 * 25 000 files, rather than all of them.
 *
 * Ordering rule, the same as the owner index: the marker is written before the
 * entry it indexes and removed after it, so a marker may outlive its entry
 * (a crash in between; the listing skips it) but an entry is never missing
 * from its partition. A marker without an entry is never pruned by a listing:
 * it looks exactly like a write whose marker has landed and whose entry has
 * not.
 *
 * @module storage/providers/filesystem/prefixIndex
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidId } from '../../../utils/pathSecurity.js';
import { KEY_PREFIX_SEGMENTS } from '../../namespaces.js';
import { removeIfExists } from '../../../utils/fileLock.js';
import { writeInDirectory } from '../../../utils/atomicWrite.js';
import { containedPath, prefixPartition } from './paths.js';

/** Directory of a namespace holding the partitions. */
export const PREFIXES_DIR = '.prefixes';

/**
 * Where one namespace directory keeps its prefix index, and what it indexes.
 */
export class PrefixIndex {
  /**
   * @param {Record<string, number>} [segments=KEY_PREFIX_SEGMENTS] - Namespace
   *   to segment count. Tests pass `{}` to switch the index off.
   */
  constructor(segments = KEY_PREFIX_SEGMENTS) {
    this._segments = segments || {};
  }

  /**
   * The partition a key is filed under, or null when the namespace is not
   * indexed or the key has no partition.
   *
   * @param {string} ns - Namespace
   * @param {string} keyOrPrefix - Key, or the prefix of a listing
   * @returns {string|null}
   */
  partition(ns, keyOrPrefix) {
    const n = Object.hasOwn(this._segments, ns) ? this._segments[ns] : 0;
    if (!n || typeof keyOrPrefix !== 'string') return null;
    return prefixPartition(keyOrPrefix, n);
  }

  /**
   * Write the marker for `key`, when it has a partition. Idempotent, and
   * rewritten on every write so a marker lost to a crash reappears.
   *
   * @param {string} nsDir - Absolute namespace directory
   * @param {string} ns - Namespace
   * @param {string} key - Key
   * @returns {Promise<void>}
   */
  async writeMarker(nsDir, ns, key) {
    const partition = this.partition(ns, key);
    if (!partition) return;
    const marker = containedPath(nsDir, PREFIXES_DIR, partition, key);
    await writeInDirectory(path.dirname(marker), () => fs.writeFile(marker, ''));
  }

  /**
   * Remove the marker for `key`. The partition directory stays, empty or
   * not: removing it would race a concurrent write of another key in the
   * same partition between its `mkdir` and its marker write.
   *
   * @param {string} nsDir - Absolute namespace directory
   * @param {string} ns - Namespace
   * @param {string} key - Key
   * @returns {Promise<void>}
   */
  async removeMarker(nsDir, ns, key) {
    const partition = this.partition(ns, key);
    if (!partition) return;
    await removeIfExists(containedPath(nsDir, PREFIXES_DIR, partition, key));
  }

  /**
   * The keys filed under one partition, unsorted.
   *
   * @param {string} nsDir - Absolute namespace directory
   * @param {string} partition - Partition from {@link PrefixIndex#partition}
   * @returns {Promise<string[]>}
   */
  async keys(nsDir, partition) {
    let entries;
    try {
      entries = await fs.readdir(containedPath(nsDir, PREFIXES_DIR, partition));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    }
    // Only names the store would itself accept, so a file dropped in by hand
    // never reaches a path join.
    return entries.filter(entry => isValidId(entry) && entry.startsWith(partition));
  }
}
