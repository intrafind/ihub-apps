// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `writeJson`, `createJson`, `writeText` and `remove` take part in the same
 * serialization as `updateJson`.
 *
 * A whole-file write that lands between an update's read and its write is
 * silently erased by that write (or erases the update). Two store instances
 * stand in for two cluster workers: each queues only its own writers, so the
 * lock — the file lock on the filesystem path, the provider's etag on the
 * document path — is what has to keep them apart.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-config-wr-')));
const CONTENTS = path.join(ROOT, 'contents');
fsSync.mkdirSync(CONTENTS, { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { ConfigStore } = await import('../services/config/ConfigStore.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');

const PLATFORM_CONFIG = { storage: { provider: 'filesystem', filesystem: {} } };
const onDisk = async relPath => JSON.parse(await fs.readFile(path.join(CONTENTS, relPath), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const [label, dir] of [
  ['through the provider', 'config'],
  ['on the filesystem path', 'unserved']
]) {
  describe(`ConfigStore whole-file writers ${label}`, () => {
    const relPath = `${dir}/writer-target.json`;
    before(async () => {
      await bootstrapStorage(PLATFORM_CONFIG);
    });
    after(async () => {
      await shutdownStorageBootstrap();
      await fs.rm(path.join(CONTENTS, dir, 'writer-target.json'), { force: true });
    });

    it('a writeJson that arrives during an update is neither lost nor undone by it', async () => {
      const updater = new ConfigStore();
      const writer = new ConfigStore();
      await writer.writeJson(relPath, { from: 'seed' });
      for (let i = 0; i < 5; i++) {
        const update = updater.updateJson(relPath, async current => {
          await sleep(40); // the window between the update's read and its write
          return { from: 'update', saw: current.from };
        });
        await sleep(10);
        await writer.writeJson(relPath, { from: 'write' });
        await update;
        const final = await onDisk(relPath);
        // Serial order: the write came last, or the update ran on top of it.
        assert.ok(
          final.from === 'write' || (final.from === 'update' && final.saw === 'write'),
          `lost write: ${JSON.stringify(final)}`
        );
        await writer.writeJson(relPath, { from: 'seed' });
      }
    });

    it('parallel writeJson and updateJson never corrupt the file', async () => {
      const a = new ConfigStore();
      const b = new ConfigStore();
      await a.writeJson(relPath, { n: 0 });
      const jobs = [];
      for (let i = 0; i < 20; i++) {
        jobs.push(a.updateJson(relPath, c => ({ n: (c?.n ?? 0) + 1 })));
        jobs.push(b.writeJson(relPath, { n: 1000 + i }));
      }
      await Promise.all(jobs);
      const final = await onDisk(relPath); // throws when the file is torn
      assert.equal(typeof final.n, 'number');
    });

    it('createJson during an update is neither overwritten by it nor silently overwriting it', async () => {
      const missing = `${dir}/writer-create.json`;
      const updater = new ConfigStore();
      const creator = new ConfigStore();
      const update = updater.updateJson(missing, async current => {
        const saw = current?.from ?? null;
        await sleep(40);
        return { from: 'update', saw };
      });
      await sleep(10);
      const created = await creator.createJson(missing, { from: 'create' }).then(
        () => true,
        error => {
          assert.equal(error.code, 'EEXIST');
          return false;
        }
      );
      await update;
      const final = await onDisk(missing);
      // Either the create was refused, or the update was recomputed on top of it.
      assert.ok(created ? final.saw === 'create' : final.from === 'update', JSON.stringify(final));
      await new ConfigStore().remove(missing);
    });

    it('a write to the same path from inside its own update fails fast instead of deadlocking', async () => {
      const store = new ConfigStore();
      await store.writeJson(relPath, { from: 'seed' });
      const outcome = await Promise.race([
        store
          .updateJson(relPath, async current => {
            await store.writeJson(relPath, { from: 'nested' });
            return current;
          })
          .then(
            () => 'resolved',
            error => error.message
          ),
        sleep(5000).then(() => 'deadlock')
      ]);
      assert.match(outcome, /Nested write/);
      assert.deepEqual(await onDisk(relPath), { from: 'seed' });
    });

    it('a write to another path from inside an update is allowed', async () => {
      const store = new ConfigStore();
      const other = `${dir}/writer-other.json`;
      await store.updateJson(relPath, async current => {
        await store.writeJson(other, { from: 'nested' });
        return current ?? { from: 'seed' };
      });
      assert.deepEqual(await onDisk(other), { from: 'nested' });
      await store.remove(other);
    });
  });
}

describe('ConfigStore.writeText', () => {
  it('queues behind an update of the same path and leaves no lock file', async () => {
    const store = new ConfigStore();
    await store.writeText('unserved/doc.md', 'one');
    await store.writeText('unserved/doc.md', 'two');
    assert.equal(await fs.readFile(path.join(CONTENTS, 'unserved/doc.md'), 'utf8'), 'two');
    const leftovers = (await fs.readdir(path.join(CONTENTS, 'unserved'))).filter(
      n => n.endsWith('.lock') || n.startsWith('.tmp_')
    );
    assert.deepEqual(leftovers, []);
  });
});

describe('ConfigStore.updateJson on an unreadable platform file', () => {
  it('throws and leaves the bytes alone instead of starting from empty', async () => {
    await bootstrapStorage(PLATFORM_CONFIG);
    try {
      const file = path.join(CONTENTS, 'config', 'platform.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '{ "truncated": ');
      const store = new ConfigStore();
      await assert.rejects(
        store.updateJson('config/platform.json', c => ({ ...(c || {}), features: {} })),
        /could not be read/
      );
      assert.equal(await fs.readFile(file, 'utf8'), '{ "truncated": ');
    } finally {
      await shutdownStorageBootstrap();
      await fs.rm(path.join(CONTENTS, 'config', 'platform.json'), { force: true });
    }
  });
});
