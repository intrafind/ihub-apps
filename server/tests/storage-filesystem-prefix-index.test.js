// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The filesystem provider's key-prefix index and single-pass blob walk, as
 * seen on disk: which directories a listing reads, what the index leaves
 * behind, and what it must never surface. The listing *results* are the
 * storage contract and are asserted provider-neutrally in the conformance
 * suite (`key-prefix listings`); this file is the filesystem side of it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsCallbacks from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { prefixPartition } from '../storage/providers/filesystem/paths.js';
import { walkBlobs, walkDocuments } from '../storage/walk.js';

const SEGMENTS = { scoped: 2, projectish: 1 };
const roots = [];

after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function provider(keyPrefixSegments = SEGMENTS) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-prefix-index-'));
  roots.push(baseDir);
  const instance = new FilesystemStorageProvider({
    baseDir,
    flushIntervalMs: 25,
    keyPrefixSegments,
    fenceSweepIntervalMs: 0
  });
  await instance.initialize();
  return { instance, baseDir };
}

/** Record every directory `fs.promises.readdir` is asked for while `fn` runs. */
async function readdirsDuring(fn) {
  const original = fsCallbacks.promises.readdir;
  const seen = [];
  fsCallbacks.promises.readdir = function spy(dir, ...rest) {
    seen.push(String(dir));
    return original.call(this, dir, ...rest);
  };
  try {
    await fn();
  } finally {
    fsCallbacks.promises.readdir = original;
  }
  return seen;
}

describe('prefixPartition', () => {
  it('cuts at the n-th `__`, scanning left to right', () => {
    assert.equal(prefixPartition('chat__abc__file', 2), 'chat__abc');
    assert.equal(prefixPartition('chat__abc__', 2), 'chat__abc');
    assert.equal(prefixPartition('chat__abc', 2), null);
    assert.equal(prefixPartition('p1__item__v', 1), 'p1');
    // Overlapping runs: the first `__` of `a___b` is at index 1.
    assert.equal(prefixPartition('a___b', 1), 'a');
    assert.equal(prefixPartition('a____b', 2), 'a__');
    assert.equal(prefixPartition('a___', 1), 'a');
  });

  it('has no partition where the leading part is not a usable name', () => {
    assert.equal(prefixPartition('__x__y', 1), null);
    assert.equal(prefixPartition('constructor__x', 1), null);
    assert.equal(prefixPartition('.__x', 1), null);
  });
});

describe('documents in an indexed namespace', () => {
  it('a scoped listing reads the partition, not the namespace', async () => {
    const { instance, baseDir } = await provider();
    const docs = instance.documents;
    for (let i = 0; i < 5; i++) await docs.put('scoped', `chat__other${i}__f`, { i });
    await docs.put('scoped', 'chat__mine__f1', { i: 1 });
    await docs.put('scoped', 'chat__mine__f2', { i: 2 });

    let keys;
    const dirs = await readdirsDuring(async () => {
      keys = (await docs.list('scoped', { prefix: 'chat__mine__' })).items.map(d => d.key);
    });
    assert.deepEqual(keys, ['chat__mine__f1', 'chat__mine__f2']);
    assert.deepEqual(dirs, [path.join(baseDir, 'scoped', '.prefixes', 'chat__mine')]);

    // A prefix short of the partition still reads the namespace.
    const wide = await readdirsDuring(() => docs.list('scoped', { prefix: 'chat__' }));
    assert.deepEqual(wide, [path.join(baseDir, 'scoped')]);
  });

  it('skips a marker whose document is missing, and leaves it in place', async () => {
    const { instance, baseDir } = await provider();
    await instance.documents.put('scoped', 'chat__s__live', { ok: true });
    const orphan = path.join(baseDir, 'scoped', '.prefixes', 'chat__s', 'chat__s__gone');
    await fs.writeFile(orphan, '');

    const page = await instance.documents.list('scoped', { prefix: 'chat__s__' });
    assert.deepEqual(
      page.items.map(d => d.key),
      ['chat__s__live']
    );
    await fs.access(orphan);
  });

  it('never lists `.prefixes`, and a delete removes the marker', async () => {
    const { instance, baseDir } = await provider();
    await instance.documents.put('scoped', 'chat__s__a', { a: 1 });
    const all = await instance.documents.list('scoped');
    assert.deepEqual(
      all.items.map(d => d.key),
      ['chat__s__a']
    );
    const scanned = [];
    for await (const doc of instance.documents.scan('scoped')) scanned.push(doc.key);
    assert.deepEqual(scanned, ['chat__s__a']);

    await instance.documents.delete('scoped', 'chat__s__a');
    await assert.rejects(
      fs.access(path.join(baseDir, 'scoped', '.prefixes', 'chat__s', 'chat__s__a')),
      { code: 'ENOENT' }
    );
  });

  it('a delete whose marker cannot be removed still succeeds', async () => {
    const { instance, baseDir } = await provider();
    await instance.documents.put('scoped', 'chat__s__a', { a: 1 });
    const marker = path.join(baseDir, 'scoped', '.prefixes', 'chat__s', 'chat__s__a');
    // A directory where the marker file should be: unlink fails.
    await fs.rm(marker);
    await fs.mkdir(path.join(marker, 'x'), { recursive: true });
    assert.equal(await instance.documents.delete('scoped', 'chat__s__a'), true);
    assert.equal(await instance.documents.get('scoped', 'chat__s__a'), null);
  });

  it('puts and deletes of one partition running at once all succeed', async () => {
    // Deleting the last key of a partition used to remove its directory under
    // a put of another key that had just created it.
    const { instance } = await provider();
    const docs = instance.documents;
    for (let round = 0; round < 30; round++) {
      await docs.put('scoped', `chat__r__a${round}`, { round });
      await Promise.all([
        docs.delete('scoped', `chat__r__a${round}`),
        docs.put('scoped', `chat__r__b${round}`, { round })
      ]);
    }
    const keys = (await docs.list('scoped', { prefix: 'chat__r__' })).items.map(d => d.key);
    assert.equal(keys.length, 30);
    assert.ok(keys.every(key => key.startsWith('chat__r__b')));
  });

  it('writes no markers for a namespace that is not indexed', async () => {
    const { instance, baseDir } = await provider();
    await instance.documents.put('plain', 'chat__s__a', { a: 1 });
    await assert.rejects(fs.access(path.join(baseDir, 'plain', '.prefixes')), { code: 'ENOENT' });
  });
});

describe('blobs in an indexed namespace', () => {
  it('a scoped listing reads the partition, not the namespace', async () => {
    const { instance, baseDir } = await provider();
    const blobs = instance.blobs;
    for (let i = 0; i < 5; i++) await blobs.put('projectish', `p${i}__item__v`, 'x');
    await blobs.put('projectish', 'mine__item__v1', 'abc');

    let items;
    const dirs = await readdirsDuring(async () => {
      items = (await blobs.list('projectish', { prefix: 'mine__item__' })).items;
    });
    assert.deepEqual(items, [{ key: 'mine__item__v1', bytes: 3 }]);
    assert.deepEqual(dirs, [path.join(baseDir, 'blobs', 'projectish', '.prefixes', 'mine')]);
  });

  it('skips a marker whose blob is missing, and leaves it in place', async () => {
    const { instance, baseDir } = await provider();
    await instance.blobs.put('projectish', 'p__i__live', 'x');
    const orphan = path.join(baseDir, 'blobs', 'projectish', '.prefixes', 'p', 'p__i__gone');
    await fs.writeFile(orphan, '');

    const page = await instance.blobs.list('projectish', { prefix: 'p__' });
    assert.deepEqual(
      page.items.map(item => item.key),
      ['p__i__live']
    );
    await fs.access(orphan);
  });

  it('never lists `.prefixes` or a write in flight, and refuses `.prefixes` as a key', async () => {
    const { instance, baseDir } = await provider();
    await instance.blobs.put('projectish', 'p__i__v', 'x');
    await fs.writeFile(path.join(baseDir, 'blobs', 'projectish', '.tmp_123'), 'half');

    const page = await instance.blobs.list('projectish');
    assert.deepEqual(
      page.items.map(item => item.key),
      ['p__i__v']
    );
    const scanned = [];
    for await (const item of instance.blobs.scan('projectish')) scanned.push(item.key);
    assert.deepEqual(scanned, ['p__i__v']);

    await assert.rejects(() => instance.blobs.put('projectish', '.prefixes', 'x'));
    await assert.rejects(() => instance.blobs.put('projectish', '.tmp_mine', 'x'));
    await assert.rejects(() => instance.blobs.delete('projectish', '.prefixes'));
  });

  it('removes the marker with the blob', async () => {
    const { instance, baseDir } = await provider();
    await instance.blobs.put('projectish', 'p__i__v', 'x');
    assert.equal(await instance.blobs.delete('projectish', 'p__i__v'), true);
    await assert.rejects(
      fs.access(path.join(baseDir, 'blobs', 'projectish', '.prefixes', 'p', 'p__i__v')),
      { code: 'ENOENT' }
    );
  });

  it('a delete of a missing blob removes a marker left behind', async () => {
    const { instance, baseDir } = await provider();
    const marker = path.join(baseDir, 'blobs', 'projectish', '.prefixes', 'p', 'p__i__gone');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, '');
    assert.equal(await instance.blobs.delete('projectish', 'p__i__gone'), false);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  });

  it('puts and deletes of one partition running at once all succeed', async () => {
    const { instance } = await provider();
    const blobs = instance.blobs;
    for (let round = 0; round < 30; round++) {
      await blobs.put('projectish', `p__a__${round}`, 'x');
      await Promise.all([
        blobs.delete('projectish', `p__a__${round}`),
        blobs.put('projectish', `p__b__${round}`, 'y')
      ]);
    }
    const keys = (await blobs.list('projectish', { prefix: 'p__' })).items.map(b => b.key);
    assert.equal(keys.length, 30);
    assert.ok(keys.every(key => key.startsWith('p__b__')));
  });
});

describe('one directory read per walk', () => {
  it('a blob scan reads the namespace once, where paging list reads it per page', async () => {
    const { instance, baseDir } = await provider({});
    for (let i = 0; i < 30; i++) {
      await instance.blobs.put('walked', `k${String(i).padStart(2, '0')}`, 'x');
    }
    const nsDir = path.join(baseDir, 'blobs', 'walked');

    let scanned = 0;
    const scanDirs = await readdirsDuring(async () => {
      for await (const _item of instance.blobs.scan('walked')) scanned += 1;
    });
    assert.equal(scanned, 30);
    assert.deepEqual(scanDirs, [nsDir]);

    const pagedDirs = await readdirsDuring(async () => {
      let cursor = null;
      do {
        const page = await instance.blobs.list('walked', {
          limit: 10,
          ...(cursor ? { cursor } : {})
        });
        cursor = page.nextCursor;
      } while (cursor);
    });
    assert.equal(pagedDirs.length, 3, 'the paged walk this replaces');

    const walkDirs = await readdirsDuring(async () => {
      for await (const _item of walkBlobs(instance.blobs, 'walked')) scanned += 1;
    });
    assert.deepEqual(walkDirs, [nsDir]);
  });

  it('walkDocuments pages a store that only has list', async () => {
    const pages = {
      null: { items: [{ key: 'a' }, { key: 'b' }], nextCursor: 'c1' },
      c1: { items: [{ key: 'c' }], nextCursor: null }
    };
    const calls = [];
    const double = {
      async list(ns, opts) {
        calls.push({ ns, ...opts });
        return pages[opts.cursor ?? null];
      }
    };
    const keys = [];
    for await (const doc of walkDocuments(double, 'ns', { prefix: 'x', limit: 2 })) {
      keys.push(doc.key);
    }
    assert.deepEqual(keys, ['a', 'b', 'c']);
    assert.deepEqual(calls, [
      { ns: 'ns', prefix: 'x', limit: 2 },
      { ns: 'ns', prefix: 'x', limit: 2, cursor: 'c1' }
    ]);
  });
});

describe('a walk reads ahead', () => {
  it('reads documents in parallel batches, as a page of `list` does, and keeps key order', async () => {
    const { instance } = await provider();
    for (let i = 0; i < 40; i += 1) {
      await instance.documents.put('scoped', `chat__A__${String(i).padStart(2, '0')}`, { i });
    }
    const store = instance._envelopeDocuments;
    const original = store._readEnvelope.bind(store);
    let active = 0;
    let peak = 0;
    store._readEnvelope = async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        return await original(...args);
      } finally {
        active -= 1;
      }
    };
    const seen = [];
    for await (const doc of walkDocuments(store, 'scoped', { prefix: 'chat__A__' })) {
      seen.push(doc.data.i);
    }
    assert.deepEqual(
      seen,
      Array.from({ length: 40 }, (_, i) => i)
    );
    assert.ok(peak > 1, `read one document at a time (peak ${peak})`);
  });
});
