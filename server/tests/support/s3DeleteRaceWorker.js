// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for `storage-s3-contract-edges.test.js`: one iHub server
 * process as far as blob deletes are concerned. It composes the storage
 * provider the way `storage.blobs.provider: "s3"` does (filesystem documents
 * and locks in `baseDir`, blobs in the bucket) and deletes one key each time
 * the parent says so.
 *
 * Environment: `IHUB_RACE_WORKER` holds JSON `{ s3, baseDir }`, where `s3` is
 * a `storage.blobs.s3` block and `baseDir` the data directory whose lock
 * manager the delete uses. `CONTENTS_DIR` must point at a scratch directory.
 *
 * Messages in: `{ round, ns, key }`. Messages out: `{ ready: true }` once,
 * then `{ round, removed }` or `{ round, error }` per delete.
 */
import './scratchContents.js';
import { ComposedStorageProvider } from '../../storage/ComposedStorageProvider.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { createS3BlobBackend } from '../../storage/providers/s3/index.js';
import { fixedKeys } from './blobTestSupport.js';

const { s3, baseDir } = JSON.parse(process.env.IHUB_RACE_WORKER);
const keyModule = await import('../../crypto/KeyProvider.js');

const base = new FilesystemStorageProvider({ baseDir, fenceSweepIntervalMs: 0 });
const backend = createS3BlobBackend(s3, {
  platformConfig: {},
  locks: base.locks,
  env: {},
  encryption: { enabled: true, plaintextReads: 'reject' },
  loadKeys: async () => fixedKeys(keyModule)
});
const provider = new ComposedStorageProvider({ base, backend });
await provider.initialize();

process.on('message', async message => {
  if (message?.stop) {
    await provider.shutdown().catch(() => {});
    process.exit(0);
  }
  try {
    const removed = await provider.blobs.delete(message.ns, message.key);
    process.send({ round: message.round, removed });
  } catch (error) {
    process.send({ round: message.round, error: `${error.code || error.name}: ${error.message}` });
  }
});
process.send({ ready: true });
