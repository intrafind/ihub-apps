/**
 * `ConfigStore.updateJson`: a read-modify-write that concurrent writers cannot
 * interleave with.
 *
 * Cluster workers share `contents/`. A `readJson` followed by a `writeJson` is
 * last-write-wins across them: two workers that each add an OAuth client to
 * the same file both write, and the second write erases the first client.
 *
 * Two store instances stand in for two workers — each queues only its own
 * updates, as separate processes would — over a real provider on a scratch
 * `contents/`. `config/` is served by the provider (etag compare-and-set);
 * a directory no namespace declares takes the filesystem path (a lock file).
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-config-upd-')));
const CONTENTS = path.join(ROOT, 'contents');
fsSync.mkdirSync(CONTENTS, { recursive: true });

// Pinned before any server module is imported; see config-store-semantics.
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { ConfigStore } = await import('../services/config/ConfigStore.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');

const PLATFORM_CONFIG = { storage: { provider: 'filesystem', filesystem: {} } };

const onDisk = async relPath => JSON.parse(await fs.readFile(path.join(CONTENTS, relPath), 'utf8'));

const addItem = item => current => ({ items: [...(current?.items || []), item] });

for (const [label, relPath] of [
  ['through the provider', 'config/update-target.json'],
  ['on the filesystem path', 'unserved/update-target.json']
]) {
  describe(`ConfigStore.updateJson ${label}`, () => {
    before(async () => {
      await bootstrapStorage(PLATFORM_CONFIG);
    });

    after(async () => {
      await shutdownStorageBootstrap();
      await fs.rm(path.join(CONTENTS, path.dirname(relPath)), { recursive: true, force: true });
    });

    it('creates the file from null when it does not exist', async () => {
      const store = new ConfigStore();
      const outcome = await store.updateJson(relPath, current => {
        assert.equal(current, null);
        return { items: ['first'] };
      });
      assert.deepEqual(outcome, { data: { items: ['first'] }, written: true });
      assert.deepEqual(await onDisk(relPath), { items: ['first'] });
    });

    it('keeps every change when two workers update at once', async () => {
      const workerA = new ConfigStore();
      const workerB = new ConfigStore();
      await Promise.all(
        Array.from({ length: 12 }, (_, i) => [
          workerA.updateJson(relPath, addItem(`a${i}`)),
          workerB.updateJson(relPath, addItem(`b${i}`))
        ]).flat()
      );
      const { items } = await onDisk(relPath);
      assert.equal(items.length, 25);
      assert.equal(new Set(items).size, 25);
    });

    it('hands the change a private copy and writes nothing for undefined', async () => {
      const store = new ConfigStore();
      const before = await fs.stat(path.join(CONTENTS, relPath));
      const outcome = await store.updateJson(relPath, current => {
        current.items.length = 0;
        return undefined;
      });
      assert.equal(outcome.written, false);
      assert.equal(outcome.data.items.length, 0, 'the copy the change was handed');
      const after = await fs.stat(path.join(CONTENTS, relPath));
      assert.equal(after.mtimeMs, before.mtimeMs, 'the file was not rewritten');
      assert.equal((await onDisk(relPath)).items.length, 25);
    });

    it('refuses to change a file it cannot parse, leaving it as it is', async () => {
      const target = path.join(CONTENTS, relPath);
      const original = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, '{"items": ["torn"', 'utf8');
      try {
        await assert.rejects(
          new ConfigStore().updateJson(relPath, addItem('never')),
          /could not be read/
        );
        assert.equal(await fs.readFile(target, 'utf8'), '{"items": ["torn"');
      } finally {
        await fs.writeFile(target, original, 'utf8');
      }
    });

    it('a change that throws leaves the file untouched and the next update runs', async () => {
      const store = new ConfigStore();
      await assert.rejects(
        store.updateJson(relPath, () => {
          throw new Error('refused');
        }),
        /refused/
      );
      await store.updateJson(relPath, addItem('after'));
      assert.equal((await onDisk(relPath)).items.at(-1), 'after');
      assert.equal(fsSync.existsSync(path.join(CONTENTS, `${relPath}.lock`)), false);
    });
  });
}

describe('ConfigStore.updateJson: a write between the read and the write', () => {
  const relPath = 'config/interleaved.json';

  before(async () => {
    await bootstrapStorage(PLATFORM_CONFIG);
  });

  after(async () => {
    await shutdownStorageBootstrap();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('re-runs the change on the newer body instead of overwriting it', async () => {
    const workerA = new ConfigStore();
    const workerB = new ConfigStore();
    await workerA.writeJson(relPath, { items: ['seed'] });

    const seen = [];
    await workerA.updateJson(relPath, async current => {
      seen.push(current.items.join(','));
      // Worker B writes after A has read and before A writes.
      if (seen.length === 1) await workerB.updateJson(relPath, addItem('from-b'));
      return addItem('from-a')(current);
    });

    assert.deepEqual(seen, ['seed', 'seed,from-b'], 'the change ran again on what B wrote');
    assert.deepEqual((await onDisk(relPath)).items, ['seed', 'from-b', 'from-a']);
  });
});
