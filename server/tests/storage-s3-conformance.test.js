// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The blob contract (`server/storage/__tests__/providerConformance.js`,
 * unchanged) against the storage provider as `storage.blobs.provider: "s3"`
 * composes it: filesystem documents, logs and locks, and the encrypting blob
 * store over the S3 store, here on the in-repo fake S3 server
 * (`support/fakeS3Server.js`).
 *
 * The fake does not verify request signatures and is written by the same
 * people as the adapter. A green run here proves the adapter against the
 * contract, not against a real S3 service; that needs the same sections run
 * against a real S3-compatible server.
 *
 * Both encryption modes run: on (strict), which is what a bucket should be
 * used with, and off, where blobs are uploaded as they are.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, describe } from 'node:test';
import {
  PREFIX_LISTING_NAMESPACES,
  runProviderConformance
} from '../storage/__tests__/providerConformance.js';
import { KEY_PREFIX_SEGMENTS } from '../storage/namespaces.js';
import { startFakeS3Server } from './support/fakeS3Server.js';
import { composeS3Provider, fixedKeys } from './support/blobTestSupport.js';

// The key module reads the contents directory when it is imported.
const scratchContents = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-conf-contents-'));
process.env.CONTENTS_DIR = scratchContents;
const keyModule = await import('../crypto/KeyProvider.js');

/** What the composed provider reports: the filesystem set, with the blob facet declared. */
const CAPABILITIES = {
  transactions: false,
  notifications: 'in-process',
  locking: 'advisory-single-machine',
  search: false,
  multiInstance: false,
  blobs: true,
  blobStore: true,
  conditionalWrites: true,
  encryptionAtRest: 'off'
};

/** The sections that touch the blob facet or the provider's lifecycle. */
const SECTIONS = ['lifecycle', 'the blob facet', 'key-prefix listings', 'prefix deletes'];

let s3 = null;

before(async () => {
  s3 = await startFakeS3Server({ buckets: ['ihub-test'] });
});

after(async () => {
  await s3?.close();
  await fs.rm(scratchContents, { recursive: true, force: true });
});

/**
 * A factory in the shape the suite asks for: a fresh scratch directory and a
 * fresh bucket prefix per call, both reused with `{ reuse: true }`.
 *
 * @param {{enabled: boolean, plaintextReads: 'reject'|'accept'}} encryption
 * @returns {Function}
 */
function factoryFor(encryption) {
  let last = null;
  return async function createProvider({ reuse = false } = {}) {
    const location =
      reuse && last
        ? last
        : {
            baseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-s3-conf-')),
            prefix: `conf-${crypto.randomBytes(6).toString('hex')}`
          };
    last = location;
    const { provider } = await composeS3Provider({
      s3,
      keys: fixedKeys(keyModule),
      baseDir: location.baseDir,
      config: { prefix: location.prefix },
      encryption,
      filesystem: { keyPrefixSegments: { ...KEY_PREFIX_SEGMENTS, ...PREFIX_LISTING_NAMESPACES } }
    });
    return {
      provider,
      cleanup: async () => {
        await fs.rm(location.baseDir, { recursive: true, force: true });
        for (const { key } of s3.rawObjects('ihub-test', `${location.prefix}/`)) {
          s3.rawDelete('ihub-test', key);
        }
        if (last === location) last = null;
      }
    };
  };
}

describe('S3 blob backend, encryption on', () => {
  runProviderConformance({
    // The registry name the composed provider reports: its base provider's.
    name: 'filesystem',
    createProvider: factoryFor({ enabled: true, plaintextReads: 'reject' }),
    capabilities: CAPABILITIES,
    sections: SECTIONS
  });
});

describe('S3 blob backend, encryption off', () => {
  runProviderConformance({
    name: 'filesystem',
    createProvider: factoryFor({ enabled: false, plaintextReads: 'accept' }),
    capabilities: CAPABILITIES,
    sections: SECTIONS
  });
});
