// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Edges of the blob contract that are hard on S3 and that the shared
 * conformance suite does not reach: a delete raced by two server processes,
 * a paging cursor while keys come and go, prefix and ordering corner cases,
 * and keys at the limits of length and alphabet.
 *
 * Runs on the in-repo fake S3 server, and on a real S3-compatible server when
 * `IHUB_TEST_S3_ENDPOINT` is set (`support/s3TestBackend.js`). Ordering and
 * key encoding are where real servers differ from the fake, so the external
 * run is the one that counts for those.
 */
import './support/scratchContents.js';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeS3Provider, fixedKeys } from './support/blobTestSupport.js';
import { describeS3Targets } from './support/s3TestBackend.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-edges-'));
const keyModule = await import('../crypto/KeyProvider.js');
const { compareBlobKeys, encodeBlobCursor } = await import('../storage/blobSupport.js');

const WORKER = fileURLToPath(new URL('./support/s3DeleteRaceWorker.js', import.meta.url));

/** Every character a key may hold, in the order S3 lists them (UTF-8 bytes). */
const ALPHABET = '-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

after(() => fs.rm(scratch, { recursive: true, force: true }));

/**
 * One server process that deletes on request.
 *
 * @param {Object} s3 - `storage.blobs.s3` block.
 * @param {string} baseDir - Data directory (its lock manager guards the delete).
 * @returns {Promise<{remove: (round: number, ns: string, key: string) => Promise<boolean>, stop: () => Promise<void>}>}
 */
async function startDeleter(s3, baseDir) {
  const child = fork(WORKER, [], {
    env: {
      ...process.env,
      CONTENTS_DIR: path.join(scratch, `worker-contents-${crypto.randomBytes(3).toString('hex')}`),
      IHUB_RACE_WORKER: JSON.stringify({ s3, baseDir })
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  const waiting = new Map();
  let ready;
  let failed;
  const started = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  child.on('message', message => {
    if (message.ready) return ready();
    const settle = waiting.get(message.round);
    waiting.delete(message.round);
    if (message.error) settle?.reject(new Error(message.error));
    else settle?.resolve(message.removed);
  });
  child.on('exit', code => {
    const error = new Error(`delete worker exited with code ${code}: ${stderr.slice(-2000)}`);
    failed(error);
    for (const settle of waiting.values()) settle.reject(error);
  });
  await started;
  return {
    remove: (round, ns, key) =>
      new Promise((resolve, reject) => {
        waiting.set(round, { resolve, reject });
        child.send({ round, ns, key });
      }),
    stop: () =>
      new Promise(resolve => {
        child.removeAllListeners('exit');
        child.once('exit', () => resolve());
        child.send({ stop: true });
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      })
  };
}

describeS3Targets('S3 blob contract edges', target => {
  let s3;
  let blobs;
  let composed;
  const extraDirs = [];

  before(async () => {
    s3 = await target.open();
    composed = await composeS3Provider({ s3: {}, keys: fixedKeys(keyModule), config: s3.config() });
    await composed.provider.initialize();
    blobs = composed.provider.blobs;
  });

  after(async () => {
    await composed?.provider.shutdown().catch(() => {});
    if (composed) await fs.rm(composed.baseDir, { recursive: true, force: true });
    for (const dir of extraDirs) await fs.rm(dir, { recursive: true, force: true });
    await s3?.close();
  });

  /** A namespace no other test of this file uses. */
  const freshNs = () => `edge-${crypto.randomBytes(4).toString('hex')}`;

  it('two server processes deleting the same key: exactly one reports true, every round', async () => {
    const ns = freshNs();
    // Both processes use the data directory of this suite's provider, as two
    // cluster workers of one installation do: that is where the lock lives.
    const deleters = await Promise.all([
      startDeleter(s3.config(), composed.baseDir),
      startDeleter(s3.config(), composed.baseDir)
    ]);
    try {
      const rounds = 30;
      for (let round = 0; round < rounds; round++) {
        const key = `claim__${round}`;
        await blobs.put(ns, key, 'x');
        const removed = await Promise.all(deleters.map(deleter => deleter.remove(round, ns, key)));
        assert.deepEqual([...removed].sort(), [false, true], `round ${round}: ${removed}`);
        assert.equal(await blobs.get(ns, key), null);
      }
      // A key nobody wrote: neither claims it.
      assert.deepEqual(
        await Promise.all(deleters.map(deleter => deleter.remove(rounds, ns, 'never-written'))),
        [false, false]
      );
    } finally {
      await Promise.all(deleters.map(deleter => deleter.stop()));
    }
  });

  // Needs HeadObject requests held back, which only the fake can do. Not registered for the
  // external backend at all: a skip there would hide in a green run.
  if (target.kind === 'fake') {
    it('control: the race is real — without a shared lock directory both processes report true', async () => {
      // This is what the test above would see if `delete` took no lock. It is
      // also the documented limit of the promise: two servers that do not
      // share a data directory (capabilities.multiInstance is false) both
      // claim the key.
      const ns = freshNs();
      const dirs = await Promise.all(
        [0, 1].map(() => fs.mkdtemp(path.join(os.tmpdir(), 'ihub-s3-edges-apart-')))
      );
      extraDirs.push(...dirs);
      const deleters = await Promise.all(dirs.map(dir => startDeleter(s3.config(), dir)));
      // Both HeadObject requests are held until both have arrived, so each
      // process has asked "is it there?" before either deletes. No timing.
      let open;
      const hold = new Promise(resolve => (open = resolve));
      const release = s3.fake.inject({ op: 'HeadObject', key: `/${ns}/claim`, hold });
      try {
        await blobs.put(ns, 'claim', 'x');
        s3.fake.clearRequests();
        const racing = Promise.all(deleters.map(deleter => deleter.remove(0, ns, 'claim')));
        const heads = () => s3.fake.requests.filter(request => request.op === 'HeadObject').length;
        for (let waited = 0; heads() < 2; waited += 20) {
          assert.ok(waited < 15_000, `only ${heads()} of 2 HeadObject requests arrived`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        open();
        assert.deepEqual(await racing, [true, true]);
      } finally {
        open();
        release();
        await Promise.all(deleters.map(deleter => deleter.stop()));
      }
    });
  }

  it('a paging cursor keeps its place while keys are deleted and added', async () => {
    const ns = freshNs();
    const keys = ['k01', 'k02', 'k03', 'k04', 'k05', 'k06', 'k07'];
    for (const key of keys) await blobs.put(ns, key, key);

    const first = await blobs.list(ns, { limit: 3 });
    assert.deepEqual(
      first.items.map(item => item.key),
      ['k01', 'k02', 'k03']
    );
    assert.ok(first.nextCursor);

    // The key the cursor stands on goes, so does the next one; one key appears
    // before the cursor and one after it.
    assert.equal(await blobs.delete(ns, 'k03'), true);
    assert.equal(await blobs.delete(ns, 'k04'), true);
    await blobs.put(ns, 'k00', 'before the cursor');
    await blobs.put(ns, 'k055', 'after the cursor');

    const rest = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await blobs.list(ns, { limit: 2, cursor });
      rest.push(...page.items.map(item => item.key));
      cursor = page.nextCursor;
    }
    assert.deepEqual(rest, ['k05', 'k055', 'k06', 'k07'], 'no repeat, no skip, nothing before');

    // A cursor behind the last key ends the listing; it is not an error.
    assert.deepEqual(await blobs.list(ns, { cursor: encodeBlobCursor('zzz') }), {
      items: [],
      nextCursor: null
    });
    // A cursor is a position, not a key that must exist or even be valid.
    assert.deepEqual(
      (await blobs.list(ns, { cursor: encodeBlobCursor('k06x') })).items.map(item => item.key),
      ['k07']
    );
    // Everything deleted while a cursor is held: the next page is empty.
    const held = (await blobs.list(ns, { limit: 1 })).nextCursor;
    assert.equal(await blobs.deletePrefix(ns, 'k'), 7);
    assert.deepEqual(await blobs.list(ns, { cursor: held }), { items: [], nextCursor: null });
  });

  it('rejects a cursor that is not one of its own, and clamps odd limits', async () => {
    const ns = freshNs();
    for (const key of ['a', 'b', 'c']) await blobs.put(ns, key, key);
    for (const cursor of ['garbage', 'e30', Buffer.from('{"k":5}').toString('base64url')]) {
      await assert.rejects(blobs.list(ns, { cursor }), { code: 'INVALID_CURSOR' }, cursor);
    }
    assert.equal((await blobs.list(ns, { limit: -1 })).items.length, 1);
    assert.equal((await blobs.list(ns, { limit: 'x' })).items.length, 3);
    assert.equal((await blobs.list(ns, { limit: 2.9 })).items.length, 2);
    const exact = await blobs.list(ns, { limit: 3 });
    assert.equal(exact.items.length, 3);
    assert.equal(exact.nextCursor, null, 'a full last page announces no further page');
  });

  it('orders every character a key may hold as the contract says, page by page', async () => {
    const ns = freshNs();
    // One key per character, in front and in second place, plus mixed case.
    const keys = new Set();
    for (const char of ALPHABET) {
      if (char !== '.') keys.add(char);
      keys.add(`m${char}`);
      keys.add(`m${char}z`);
    }
    keys.delete('m.'); // kept below, on its own
    for (const key of ['m.', 'M', 'mM', 'Mm', '0', '00', '-', '--', '_', '__', '.a', 'a.']) {
      keys.add(key);
    }
    const expected = [...keys].sort(compareBlobKeys);
    for (let start = 0; start < expected.length; start += 25) {
      await Promise.all(expected.slice(start, start + 25).map(key => blobs.put(ns, key, key)));
    }

    const scanned = [];
    for await (const item of blobs.scan(ns)) scanned.push(item.key);
    assert.deepEqual(scanned, expected);

    // One key per page: every key is a page boundary once.
    const paged = [];
    let cursor = null;
    do {
      const page = await blobs.list(ns, { limit: 1, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map(item => item.key));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(paged, expected);

    // And the server itself lists in that order (UTF-8 bytes = code units for
    // this alphabet). On a real server this is the assumption the adapter rests on.
    const base = `${s3.prefix}/default/${ns}/`;
    const raw = (await s3.rawObjects(base)).map(object => object.key.slice(base.length));
    assert.deepEqual(raw, expected);

    // Each payload is still its key: no two names collapsed into one object
    // (a case-insensitive or normalising server would do that).
    for (const key of ['M', 'm', 'mM', 'Mm', 'm.', 'm-', 'm_', '.a', 'a.']) {
      assert.equal((await blobs.get(ns, key)).data.toString(), key, key);
    }
  });

  it('matches a prefix literally: whole keys, longer prefixes, dots and separators', async () => {
    const ns = freshNs();
    const sibling = `${ns}-2`;
    const dotted = `${ns}.x`;
    for (const key of ['a', 'a.b', 'a-b', 'a_b', 'a__b', 'ab', 'A', 'b'])
      await blobs.put(ns, key, key);
    await blobs.put(sibling, 'a', 'sibling');
    await blobs.put(dotted, 'a', 'dotted');
    const list = async prefix => (await blobs.list(ns, { prefix })).items.map(item => item.key);

    assert.deepEqual(await list('a'), ['a', 'a-b', 'a.b', 'a__b', 'a_b', 'ab']);
    assert.deepEqual(await list('a_'), ['a__b', 'a_b']);
    assert.deepEqual(await list('a.'), ['a.b']);
    assert.deepEqual(await list('a.b'), ['a.b'], 'a prefix equal to a whole key');
    assert.deepEqual(await list('a.bc'), [], 'a prefix longer than every key');
    assert.deepEqual(await list('B'), [], 'prefixes are case sensitive');
    assert.deepEqual(await list(''), ['A', 'a', 'a-b', 'a.b', 'a__b', 'a_b', 'ab', 'b']);
    // Characters no key can hold match nothing; they are not passed to the server.
    for (const prefix of ['a/', '/', 'a%', 'a b', 'ä', 'a*', '../', 'a\\']) {
      assert.deepEqual(await list(prefix), [], JSON.stringify(prefix));
    }
    // A namespace whose name starts with this one is not part of it.
    assert.equal((await blobs.list(ns)).items.length, 8);

    assert.equal(await blobs.deletePrefix(ns, 'a_'), 2);
    assert.equal(await blobs.deletePrefix(ns, 'a.b'), 1);
    assert.equal(await blobs.deletePrefix(ns, 'zz'), 0);
    assert.deepEqual(await list(''), ['A', 'a', 'a-b', 'ab', 'b']);
    assert.equal(await blobs.deletePrefix(ns, 'a'), 3);
    assert.deepEqual(await list(''), ['A', 'b']);
    assert.equal((await blobs.get(sibling, 'a')).data.toString(), 'sibling');
    assert.equal((await blobs.get(dotted, 'a')).data.toString(), 'dotted');
    await assert.rejects(blobs.deletePrefix(ns, ''), { name: 'InvalidKeyError' });
    assert.deepEqual(await list(''), ['A', 'b'], 'an empty prefix deleted nothing');
  });

  it('stores, reads, lists and deletes keys at the length and character limits', async () => {
    const longNs = `n${'s'.repeat(99)}`;
    const ns = freshNs();
    const edge = [
      'k'.repeat(100),
      `-${'x'.repeat(98)}.`,
      `_${'.-_'.repeat(33)}`,
      ALPHABET.replace('.', '').slice(0, 64),
      '-',
      '_',
      '0',
      '.a',
      'a.',
      '-.-',
      'CON',
      'nul.txt',
      'chat__0f8fad5b-d9cb-469f-a165-70867728950e__file.txt'
    ];
    for (const key of edge) {
      assert.equal(key.length <= 100, true, key);
      const payload = `payload of ${key}`;
      const ref = await blobs.put(ns, key, payload);
      assert.equal(ref.key, key);
      assert.equal((await blobs.get(ns, key)).data.toString(), payload, key);
    }
    assert.deepEqual(
      (await blobs.list(ns)).items.map(item => item.key),
      [...edge].sort(compareBlobKeys)
    );
    for (const key of edge) assert.equal(await blobs.delete(ns, key), true, key);
    assert.deepEqual((await blobs.list(ns)).items, []);

    // The longest namespace with the longest key.
    await blobs.put(longNs, 'k'.repeat(100), 'long');
    assert.equal((await blobs.get(longNs, 'k'.repeat(100))).data.toString(), 'long');
    assert.deepEqual((await blobs.list(longNs, { prefix: 'k'.repeat(100) })).items, [
      { key: 'k'.repeat(100), bytes: 4 }
    ]);
    assert.equal(await blobs.deletePrefix(longNs, 'k'), 1);
  });

  it('refuses a key or namespace outside the limits before it sends anything', async () => {
    const ns = freshNs();
    s3.fake?.clearRequests();
    const refused = [
      'k'.repeat(101),
      '',
      '.',
      '..',
      'a..b',
      'a/b',
      '/a',
      'a\\b',
      'a b',
      'a%2Fb',
      'ä',
      'a\u0000',
      'a\n',
      '__proto__',
      'constructor',
      '.prefixes',
      '.tmp_upload',
      null,
      undefined,
      5,
      ['a']
    ];
    for (const key of refused) {
      const label = JSON.stringify(key)?.slice(0, 24);
      await assert.rejects(blobs.put(ns, key, 'x'), { name: 'InvalidKeyError' }, `put ${label}`);
      await assert.rejects(blobs.get(ns, key), { name: 'InvalidKeyError' }, `get ${label}`);
      await assert.rejects(blobs.delete(ns, key), { name: 'InvalidKeyError' }, `delete ${label}`);
    }
    for (const badNs of ['n'.repeat(101), '', '.', 'a/b', '..', 'ns x', null]) {
      const label = JSON.stringify(badNs)?.slice(0, 24);
      await assert.rejects(blobs.put(badNs, 'k', 'x'), { name: 'InvalidKeyError' }, `put ${label}`);
      await assert.rejects(blobs.list(badNs), { name: 'InvalidKeyError' }, `list ${label}`);
      await assert.rejects(
        blobs.deletePrefix(badNs, 'k'),
        { name: 'InvalidKeyError' },
        `deletePrefix ${label}`
      );
    }
    if (s3.fake) assert.deepEqual(s3.fake.requests, [], 'no request left the process');
    assert.deepEqual(await s3.rawObjects(`${s3.prefix}/default/${ns}/`), []);
  });

  it('keeps an overwrite whole: concurrent readers see the old or the new payload, never a mix', async () => {
    const ns = freshNs();
    const older = Buffer.alloc(300_000, 0x61);
    const newer = Buffer.alloc(200_000, 0x62);
    await blobs.put(ns, 'k', older);
    const reads = [];
    const write = blobs.put(ns, 'k', newer);
    for (let index = 0; index < 8; index++) reads.push(blobs.get(ns, 'k'));
    await write;
    for (const read of await Promise.all(reads)) {
      assert.ok(read.data.equals(older) || read.data.equals(newer), `${read.bytes} bytes`);
    }
    assert.ok((await blobs.get(ns, 'k')).data.equals(newer));
    assert.deepEqual((await blobs.list(ns)).items, [{ key: 'k', bytes: newer.length }]);
  });
});
