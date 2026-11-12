// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How the filesystem blob store deletes: a blob is renamed aside under
 * DELETING_PREFIX, then unlinked. Pinned here: that prefix can never be a
 * key, a failed unlink still reports the removal, and what such a failure
 * leaves behind is removed when the provider starts.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { DELETING_PREFIX } from '../storage/providers/filesystem/FilesystemBlobStore.js';
import { isValidId } from '../utils/pathSecurity.js';

const NS = 'blob-delete-test';
const dirs = [];

async function startProvider(baseDir) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-blob-delete-')));
  if (!baseDir) dirs.push(dir);
  const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
  await provider.initialize();
  return { provider, dir, nsDir: path.join(dir, 'blobs', NS) };
}

after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

describe('filesystem blob delete', () => {
  it('uses a prefix no key can carry, so it never hides a blob', () => {
    assert.equal(isValidId(DELETING_PREFIX), false);
    assert.equal(isValidId(`${DELETING_PREFIX}0123abcd`), false);
    assert.equal(isValidId(`${DELETING_PREFIX}x.json`), false);
  });

  it('reports the removal when the key is gone but the unlink fails', async () => {
    const { provider, nsDir } = await startProvider();
    await provider.blobs.put(NS, 'stuck', Buffer.from('x'));
    const unlink = fsSync.promises.unlink;
    fsSync.promises.unlink = async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    let removed;
    try {
      removed = await provider.blobs.delete(NS, 'stuck');
    } finally {
      fsSync.promises.unlink = unlink;
    }
    assert.equal(removed, true);
    assert.equal(await provider.blobs.get(NS, 'stuck'), null);
    const left = await fs.readdir(nsDir);
    assert.equal(left.length, 1);
    assert.ok(left[0].startsWith(DELETING_PREFIX));
    assert.deepEqual((await provider.blobs.list(NS)).items, [], 'a leftover is never listed');
    await provider.shutdown();
  });

  it('removes what interrupted deletes left behind when the provider starts', async () => {
    const first = await startProvider();
    await first.provider.blobs.put(NS, 'kept', Buffer.from('k'));
    await fs.writeFile(path.join(first.nsDir, `${DELETING_PREFIX}deadbeef`), 'left');
    await first.provider.shutdown();

    const second = await startProvider(first.dir);
    assert.deepEqual(await fs.readdir(second.nsDir), ['kept']);
    assert.deepEqual((await second.provider.blobs.get(NS, 'kept')).data, Buffer.from('k'));
    await second.provider.shutdown();
  });
});
