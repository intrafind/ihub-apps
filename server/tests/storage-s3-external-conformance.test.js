// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The blob contract (`server/storage/__tests__/providerConformance.js`,
 * unchanged) against a REAL S3-compatible server: the one named by
 * `IHUB_TEST_S3_ENDPOINT` (see `support/s3TestBackend.js` for the variables,
 * `docker/docker-compose.s3.yml` and `npm run s3:up` for a local one).
 *
 * `storage-s3-conformance.test.js` runs the same sections on the in-repo fake.
 * The fake does not verify signatures and lists and pages the way we believe
 * S3 does; this file is the one that proves the adapter against a server we
 * did not write.
 *
 * Without the endpoint the suites are skipped with a reason. With
 * `IHUB_TEST_S3_REQUIRED=1` a missing or unreachable server fails them.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before } from 'node:test';
import {
  PREFIX_LISTING_NAMESPACES,
  runProviderConformance
} from '../storage/__tests__/providerConformance.js';
import { KEY_PREFIX_SEGMENTS } from '../storage/namespaces.js';
import { composeS3Provider, fixedKeys } from './support/blobTestSupport.js';
import { describeS3Targets } from './support/s3TestBackend.js';

// The key module reads the contents directory when it is imported.
const scratchContents = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-ext-conf-'));
process.env.CONTENTS_DIR = scratchContents;
const keyModule = await import('../crypto/KeyProvider.js');

/**
 * What the composed provider reports: the filesystem set, with the blob facet
 * declared. `encryptionAtRest` is the base provider's and follows the switch,
 * which `composeS3Provider` hands to it as the registry does.
 *
 * @param {{enabled: boolean}} encryption
 * @returns {Object}
 */
const capabilitiesFor = encryption => ({
  ...CAPABILITIES,
  encryptionAtRest: encryption.enabled ? 'enforced' : 'off'
});

const CAPABILITIES = {
  transactions: false,
  notifications: 'in-process',
  locking: 'advisory-single-machine',
  search: false,
  multiInstance: false,
  blobs: true,
  blobStore: true,
  conditionalWrites: true,
  // Of the base provider's documents and logs; the test provider seals neither.
  encryptionAtRest: 'off'
};

const SECTIONS = ['lifecycle', 'the blob facet', 'key-prefix listings', 'prefix deletes'];

after(() => fs.rm(scratchContents, { recursive: true, force: true }));

for (const [title, encryption] of [
  ['encryption on', { enabled: true, plaintextReads: 'reject' }],
  ['encryption off', { enabled: false, plaintextReads: 'accept' }]
]) {
  describeS3Targets(
    `S3 blob backend conformance, ${title}`,
    target => {
      let s3;

      before(async () => {
        s3 = await target.open();
      });

      after(() => s3?.close());

      let last = null;
      /** A fresh data directory and a fresh prefix below this run's own, per call. */
      async function createProvider({ reuse = false } = {}) {
        const location =
          reuse && last
            ? last
            : {
                baseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-s3-ext-conf-')),
                prefix: `${s3.prefix}/conf-${crypto.randomBytes(6).toString('hex')}`
              };
        last = location;
        const { provider } = await composeS3Provider({
          s3: {},
          keys: fixedKeys(keyModule),
          baseDir: location.baseDir,
          config: s3.config({ prefix: location.prefix }),
          encryption,
          filesystem: {
            keyPrefixSegments: { ...KEY_PREFIX_SEGMENTS, ...PREFIX_LISTING_NAMESPACES }
          }
        });
        return {
          provider,
          cleanup: async () => {
            await fs.rm(location.baseDir, { recursive: true, force: true });
            for (const { key } of await s3.rawObjects(`${location.prefix}/`)) {
              await s3.rawDelete(key);
            }
            if (last === location) last = null;
          }
        };
      }

      runProviderConformance({
        name: 'filesystem',
        createProvider,
        capabilities: capabilitiesFor(encryption),
        sections: SECTIONS
      });
    },
    { kinds: ['external'] }
  );
}
