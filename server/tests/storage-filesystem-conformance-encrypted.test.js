// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The filesystem storage provider with encryption at rest enforced, driven
 * through the same provider conformance suite as without it
 * (`storage-filesystem-conformance.test.js`).
 *
 * The suite keeps its own expectations (the etag is the sha256 of the
 * canonical body, sizes, compare-and-set, listings, append-log order, spill
 * blob hashes): sealing documents and log records must not change one of
 * them. A second run covers the mode the one-time conversion runs in.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PREFIX_LISTING_NAMESPACES,
  runProviderConformance
} from '../storage/__tests__/providerConformance.js';
import { KEY_PREFIX_SEGMENTS } from '../storage/namespaces.js';
import { providerInMode, testKeys } from './support/atRestTestSupport.js';

const keys = testKeys();
const keyPrefixSegments = { ...KEY_PREFIX_SEGMENTS, ...PREFIX_LISTING_NAMESPACES };

/**
 * A factory for the suite: an uninitialized provider in `mode` over a scratch
 * directory; `reuse` re-opens the previous directory (a restart).
 *
 * @param {'converting'|'enforced'} mode
 * @returns {Function}
 */
function factoryFor(mode) {
  let lastBaseDir = null;
  return async ({ reuse = false } = {}) => {
    const baseDir =
      reuse && lastBaseDir
        ? lastBaseDir
        : await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-storage-sealed-'));
    lastBaseDir = baseDir;
    return {
      provider: providerInMode(baseDir, mode, { keys, config: { keyPrefixSegments } }),
      cleanup: async () => {
        await fs.rm(baseDir, { recursive: true, force: true });
        if (lastBaseDir === baseDir) lastBaseDir = null;
      }
    };
  };
}

const capabilities = mode => ({
  transactions: false,
  notifications: 'in-process',
  locking: 'advisory-single-machine',
  search: false,
  multiInstance: false,
  blobs: true,
  blobStore: true,
  conditionalWrites: true,
  encryptionAtRest: mode
});

runProviderConformance({
  name: 'filesystem',
  createProvider: factoryFor('enforced'),
  capabilities: capabilities('enforced')
});

runProviderConformance({
  name: 'filesystem',
  createProvider: factoryFor('converting'),
  capabilities: capabilities('converting'),
  sections: [
    'documents',
    'listing and paging',
    'key-prefix listings',
    'prefix deletes',
    'append logs',
    'blobs'
  ]
});
