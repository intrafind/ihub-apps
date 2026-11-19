// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The encrypting blob store (`server/storage/EncryptingBlobStore.js`) over an
 * in-memory store, so every case can look at, change and replace the stored
 * bytes the way someone with write access to a bucket could.
 *
 * The rule all tamper cases assert: a read either returns the payload that was
 * written for that address, or throws `CORRUPT_BLOB` / `KEY_UNAVAILABLE`. It
 * never returns `null` for an object that is there, and never returns stored
 * bytes as they are.
 */
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFileKeyProvider, getKeyProvider } from '../crypto/KeyProvider.js';
import {
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  storedLength
} from '../crypto/blobEnvelope.js';
import { EncryptingBlobStore, KEY_CHECK_KEY } from '../storage/EncryptingBlobStore.js';
import { CorruptBlobError, KeyUnavailableError } from '../storage/errors.js';
import { INTERNAL_BLOB_NAMESPACE } from '../storage/namespaces.js';
import { MASTER_KEY_A, MASTER_KEY_B, MemoryBlobStore } from './support/blobTestSupport.js';

const NS = 'chat-files';
const FIRST = ENVELOPE_SEGMENT_BYTES - 56;

const providerOf = (master, previous = null) =>
  new LocalFileKeyProvider({ readMasterKey: () => master, readPreviousKey: () => previous });

/** A store over a fresh (or given) in-memory store with master key A. */
function storeOver(inner = new MemoryBlobStore(), options = {}) {
  return {
    inner,
    store: new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A), ...options })
  };
}

const corrupt = error => error instanceof CorruptBlobError && error.code === 'CORRUPT_BLOB';
const keyUnavailable = error =>
  error instanceof KeyUnavailableError && error.code === 'KEY_UNAVAILABLE';

describe('EncryptingBlobStore: round trip', () => {
  it('returns what was written and reports the payload, not the stored object', async () => {
    const { store, inner } = storeOver();
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50, 0x4e, 0x47]);

    const ref = await store.put(NS, 'k1', payload, { contentType: 'image/png' });

    assert.deepEqual(ref, {
      key: 'k1',
      bytes: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    });
    const read = await store.get(NS, 'k1');
    assert.deepEqual(read, { key: 'k1', bytes: payload.length, data: payload });
    const stored = inner.objects.get(`${NS}/k1`);
    assert.equal(stored.length, storedLength(payload.length));
    assert.equal(stored.toString('ascii', 0, 4), 'IHB1');
    assert.equal(stored.includes(payload), false, 'the payload is not in the stored object');
  });

  it('encrypts the same payload differently each time', async () => {
    const { store, inner } = storeOver();
    await store.put(NS, 'a', 'same payload');
    const first = Buffer.from(inner.objects.get(`${NS}/a`));
    await store.put(NS, 'a', 'same payload');
    const second = inner.objects.get(`${NS}/a`);
    assert.equal(first.length, second.length);
    assert.notDeepEqual(
      first.subarray(0, ENVELOPE_HEADER_BYTES),
      second.subarray(0, ENVELOPE_HEADER_BYTES)
    );
    assert.notDeepEqual(
      first.subarray(ENVELOPE_HEADER_BYTES),
      second.subarray(ENVELOPE_HEADER_BYTES)
    );
  });

  it('stores an empty payload as an object and reads it back as an empty Buffer', async () => {
    const { store, inner } = storeOver();
    const ref = await store.put(NS, 'empty', Buffer.alloc(0));
    assert.equal(ref.bytes, 0);
    assert.equal(inner.objects.get(`${NS}/empty`).length, 568);
    const read = await store.get(NS, 'empty');
    assert.ok(Buffer.isBuffer(read.data));
    assert.equal(read.data.length, 0);
    assert.equal(read.bytes, 0);
    assert.equal((await store.put(NS, 'empty-text', '')).bytes, 0);
  });

  it('round-trips at the segment boundary, one byte under and one byte over', async () => {
    const { store, inner } = storeOver();
    const cases = [
      ['under', FIRST - 1, 512 + ENVELOPE_SEGMENT_BYTES - 1],
      ['exact', FIRST, 512 + ENVELOPE_SEGMENT_BYTES],
      ['over', FIRST + 1, 512 + ENVELOPE_SEGMENT_BYTES + 17],
      ['two-exact', FIRST + ENVELOPE_SEGMENT_BYTES - 16, 512 + 2 * ENVELOPE_SEGMENT_BYTES],
      ['two-over', FIRST + ENVELOPE_SEGMENT_BYTES - 15, 512 + 2 * ENVELOPE_SEGMENT_BYTES + 17]
    ];
    for (const [key, size, stored] of cases) {
      const payload = crypto.randomBytes(size);
      const ref = await store.put(NS, key, payload);
      assert.equal(ref.bytes, size, key);
      assert.equal(inner.objects.get(`${NS}/${key}`).length, stored, `${key}: stored length`);
      assert.ok((await store.get(NS, key)).data.equals(payload), `${key}: round trip`);
    }
    // The listing has every size right without having read one object.
    inner.gets = 0;
    const page = await store.list(NS, {});
    assert.deepEqual(
      Object.fromEntries(page.items.map(item => [item.key, item.bytes])),
      Object.fromEntries(cases.map(([key, size]) => [key, size]))
    );
    const scanned = [];
    for await (const item of store.scan(NS)) scanned.push(item);
    assert.deepEqual(scanned, page.items);
    assert.equal(inner.gets, 0, 'a listing reads no object');
  });

  it('accepts a payload that itself starts with the envelope magic', async () => {
    const { store } = storeOver();
    const payload = Buffer.concat([Buffer.from('IHB1'), crypto.randomBytes(700)]);
    await store.put(NS, 'magic', payload);
    assert.ok((await store.get(NS, 'magic')).data.equals(payload));
  });

  it('answers null for a missing key and passes deletes through', async () => {
    const { store } = storeOver();
    assert.equal(await store.get(NS, 'missing'), null);
    await store.put(NS, 'scope__a', 'x');
    await store.put(NS, 'scope__b', 'y');
    assert.equal(await store.delete(NS, 'scope__a'), true);
    assert.equal(await store.delete(NS, 'scope__a'), false);
    assert.equal(await store.deletePrefix(NS, 'scope__'), 1);
    assert.deepEqual((await store.list(NS)).items, []);
  });

  it('refuses a path-like key, a reserved key and a payload over the limit before writing', async () => {
    const { store, inner } = storeOver(new MemoryBlobStore(), { maxBlobBytes: 100 });
    await assert.rejects(store.put(NS, '../escape', 'x'), { code: 'INVALID_KEY' });
    await assert.rejects(store.get(NS, 'a/b'), { code: 'INVALID_KEY' });
    await assert.rejects(store.put('bad ns', 'k', 'x'), { code: 'INVALID_KEY' });
    await assert.rejects(store.put(NS, '.prefixes', 'x'), { code: 'INVALID_KEY' });
    await assert.rejects(store.put(NS, 'big', Buffer.alloc(101)), { code: 'BLOB_TOO_LARGE' });
    await assert.rejects(store.put(NS, 'k', 42), { code: 'INVALID_DATA' });
    assert.equal(inner.objects.size, 0, 'nothing reached the inner store');
    assert.equal((await store.put(NS, 'fits', Buffer.alloc(100))).bytes, 100);
  });
});

describe('EncryptingBlobStore: tampering', () => {
  /** Write one two-segment blob and return the stored bytes. */
  async function written() {
    const { store, inner } = storeOver();
    const payload = crypto.randomBytes(FIRST + 1000);
    await store.put(NS, 'victim', payload);
    return { store, inner, payload, stored: inner.objects.get(`${NS}/victim`) };
  }

  const flipped = (buffer, offset) => {
    const copy = Buffer.from(buffer);
    copy[offset] ^= 0x01;
    return copy;
  };

  it('rejects a changed header: magic, version, lengths, wrapped key, padding', async () => {
    const { store, inner, stored } = await written();
    // provider id (10) + key id (8) follow the 9 fixed bytes; the wrapped key after them.
    const wrappedAt = 9 + 10 + 8;
    for (const [what, offset] of [
      ['magic', 0],
      ['version', 4],
      ['provider id length', 5],
      ['key id length', 6],
      ['wrapped key length', 8],
      ['wrapped key version byte', wrappedAt],
      ['wrapped key iv', wrappedAt + 3],
      ['wrapped key tag', wrappedAt + 15],
      ['wrapped key body', wrappedAt + 40],
      ['padding', 400],
      ['last header byte', 511]
    ]) {
      inner.objects.set(`${NS}/victim`, flipped(stored, offset));
      await assert.rejects(store.get(NS, 'victim'), corrupt, what);
    }
  });

  it('rejects a changed key id or provider id as a key that is not here', async () => {
    const { store, inner, stored } = await written();
    inner.objects.set(`${NS}/victim`, flipped(stored, 9 + 10));
    await assert.rejects(store.get(NS, 'victim'), keyUnavailable, 'key id');
    inner.objects.set(`${NS}/victim`, flipped(stored, 9));
    await assert.rejects(store.get(NS, 'victim'), keyUnavailable, 'provider id');
  });

  it('rejects a changed ciphertext: stream header, salt, each segment, the last tag', async () => {
    const { store, inner, stored } = await written();
    for (const [what, offset] of [
      ['stream header length byte', 512],
      ['salt', 512 + 5],
      ['nonce prefix', 512 + 35],
      ['first segment', 512 + 1000],
      ['first segment tag', 512 + ENVELOPE_SEGMENT_BYTES - 1],
      ['second segment', 512 + ENVELOPE_SEGMENT_BYTES + 10],
      ['last tag', stored.length - 1]
    ]) {
      inner.objects.set(`${NS}/victim`, flipped(stored, offset));
      await assert.rejects(store.get(NS, 'victim'), corrupt, what);
    }
  });

  it('rejects a truncated, extended or reordered object', async () => {
    const { store, inner, stored } = await written();
    const boundary = 512 + ENVELOPE_SEGMENT_BYTES;
    for (const [what, changed] of [
      ['last byte dropped', stored.subarray(0, stored.length - 1)],
      ['cut at the segment boundary', stored.subarray(0, boundary)],
      ['cut inside the first segment', stored.subarray(0, 5000)],
      ['cut inside the header', stored.subarray(0, 300)],
      ['one byte appended', Buffer.concat([stored, Buffer.from([0])])],
      ['a segment appended', Buffer.concat([stored, stored.subarray(boundary)])],
      [
        'segments swapped',
        Buffer.concat([
          stored.subarray(0, 552),
          stored.subarray(boundary),
          stored.subarray(552, boundary)
        ])
      ],
      ['zero bytes', Buffer.alloc(0)]
    ]) {
      inner.objects.set(`${NS}/victim`, Buffer.from(changed));
      await assert.rejects(store.get(NS, 'victim'), corrupt, what);
    }
  });

  it('rejects an object moved to another key, namespace or tenant', async () => {
    const { store, inner, stored, payload } = await written();
    await store.put(NS, 'other', 'something else');

    inner.objects.set(`${NS}/other`, Buffer.from(stored));
    await assert.rejects(store.get(NS, 'other'), corrupt, 'copied over another key');

    inner.objects.set(`${NS}/new-name`, Buffer.from(stored));
    await assert.rejects(store.get(NS, 'new-name'), corrupt, 'copied to a new key');

    inner.objects.set('artifacts/victim', Buffer.from(stored));
    await assert.rejects(store.get('artifacts', 'victim'), corrupt, 'copied to another namespace');

    const otherTenant = new EncryptingBlobStore({
      inner,
      tenant: 'tenant-b',
      keyProvider: providerOf(MASTER_KEY_A)
    });
    await assert.rejects(otherTenant.get(NS, 'victim'), corrupt, 'read as another tenant');

    assert.ok((await store.get(NS, 'victim')).data.equals(payload), 'the original still opens');
  });

  it('rejects plaintext where ciphertext is expected and never returns it', async () => {
    const { store, inner } = storeOver();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(2000)]);
    for (const [what, planted] of [
      ['short text', Buffer.from('PLAINTEXT-CANARY')],
      ['long text', Buffer.from('PLAINTEXT-CANARY '.repeat(100))],
      ['json', Buffer.from(JSON.stringify({ sha: 'item', text: 'x'.repeat(900) }))],
      ['png', png],
      ['ten bytes', Buffer.alloc(10, 1)],
      ['zero bytes', Buffer.alloc(0)],
      ['magic and nothing else', Buffer.concat([Buffer.from('IHB1'), Buffer.alloc(700)])]
    ]) {
      inner.objects.set(`${NS}/planted`, planted);
      let result;
      await assert.rejects(
        async () => {
          result = await store.get(NS, 'planted');
        },
        corrupt,
        what
      );
      assert.equal(result, undefined, `${what}: nothing was returned`);
    }
    // A listing shows such an object with no size instead of failing.
    inner.objects.set(`${NS}/planted`, Buffer.from('PLAINTEXT-CANARY'));
    assert.deepEqual((await store.list(NS)).items, [{ key: 'planted', bytes: 0 }]);
  });
});

describe('EncryptingBlobStore: keys', () => {
  it('rejects a wrong master key as KEY_UNAVAILABLE, naming the key the object wants', async () => {
    const inner = new MemoryBlobStore();
    const writer = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A) });
    await writer.put(NS, 'k', 'secret payload');
    const reader = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_B) });

    await assert.rejects(reader.get(NS, 'k'), error => {
      assert.ok(keyUnavailable(error));
      assert.equal(error.httpStatus, 503);
      assert.match(error.keyId, /^[0-9a-f]{8}$/);
      assert.notEqual(error.keyId, null);
      assert.equal(error.message.includes(MASTER_KEY_A), false);
      assert.equal(error.message.includes(MASTER_KEY_B), false);
      return true;
    });
  });

  it('opens an object written with the previous key, and writes with the current one', async () => {
    const inner = new MemoryBlobStore();
    const before = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A) });
    await before.put(NS, 'old', 'written before the key change');
    const oldKeyId = inner.objects.get(`${NS}/old`).toString('ascii', 19, 27);

    const rotated = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_B, MASTER_KEY_A)
    });
    assert.equal((await rotated.get(NS, 'old')).data.toString(), 'written before the key change');
    await rotated.put(NS, 'new', 'written after the key change');
    const newKeyId = inner.objects.get(`${NS}/new`).toString('ascii', 19, 27);
    assert.notEqual(newKeyId, oldKeyId, 'new writes carry the current key id');

    // Also with the trailing newline a secret store tends to add.
    const padded = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_B, `${MASTER_KEY_A}\n`)
    });
    assert.equal((await padded.get(NS, 'old')).bytes, 29);

    const withoutPrevious = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_B)
    });
    await assert.rejects(
      withoutPrevious.get(NS, 'old'),
      error => keyUnavailable(error) && error.keyId === oldKeyId
    );
    assert.equal((await withoutPrevious.get(NS, 'new')).bytes, 28);
  });

  it('writes nothing when there is no master key or no key provider', async () => {
    const inner = new MemoryBlobStore();
    const noKey = new EncryptingBlobStore({ inner, keyProvider: providerOf(null) });
    await assert.rejects(noKey.put(NS, 'k', 'x'), keyUnavailable);
    const noProvider = new EncryptingBlobStore({
      inner,
      keyProvider: () => {
        throw new Error('not loaded');
      }
    });
    await assert.rejects(noProvider.put(NS, 'k', 'x'), keyUnavailable);
    const unknown = new EncryptingBlobStore({ inner, keyProvider: () => getKeyProvider('vault') });
    await assert.rejects(unknown.put(NS, 'k', 'x'), keyUnavailable);
    assert.equal(inner.objects.size, 0);
    assert.throws(() => new EncryptingBlobStore({ inner }), { code: 'INVALID_PROVIDER' });
    assert.throws(() => new EncryptingBlobStore({ keyProvider: providerOf(MASTER_KEY_A) }), {
      code: 'INVALID_PROVIDER'
    });
  });

  it('keeps keys and payloads out of error messages', async () => {
    const { store, inner } = storeOver();
    await store.put(NS, 'k', 'PLAINTEXT-CANARY');
    const stored = Buffer.from(inner.objects.get(`${NS}/k`));
    stored[stored.length - 1] ^= 1;
    inner.objects.set(`${NS}/k`, stored);
    await assert.rejects(store.get(NS, 'k'), error => {
      const text = `${error.message} ${error.cause?.message}`;
      assert.equal(text.includes('PLAINTEXT-CANARY'), false);
      assert.equal(text.includes(MASTER_KEY_A), false);
      return corrupt(error);
    });
  });
});

describe('EncryptingBlobStore: key check object', () => {
  const marker = `${INTERNAL_BLOB_NAMESPACE}/${KEY_CHECK_KEY}`;

  it('writes it into an empty store and verifies it afterwards', async () => {
    const { store, inner } = storeOver();
    const created = await store.verifyKey({ hasOtherObjects: async () => false });
    assert.equal(created.status, 'created');
    assert.match(created.installationId, /^[0-9a-f-]{36}$/);
    assert.equal(inner.objects.get(marker).toString('ascii', 0, 4), 'IHB1');
    const content = JSON.parse((await store.get(INTERNAL_BLOB_NAMESPACE, KEY_CHECK_KEY)).data);
    assert.deepEqual(Object.keys(content).sort(), [
      'createdAt',
      'format',
      'installationId',
      'naming'
    ]);
    assert.equal(content.format, 1);
    assert.equal(content.naming, 'plain');

    assert.deepEqual(await store.verifyKey({ hasOtherObjects: async () => true }), {
      status: 'verified',
      installationId: created.installationId
    });
  });

  it('leaves an empty store alone when asked not to write', async () => {
    const { store, inner } = storeOver();
    assert.deepEqual(await store.verifyKey({ create: false }), {
      status: 'absent',
      installationId: null
    });
    assert.equal(inner.objects.size, 0);
  });

  it('refuses another master key, and accepts it again as the previous key', async () => {
    const { store, inner } = storeOver();
    await store.verifyKey();
    const other = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_B) });
    await assert.rejects(other.verifyKey(), error => {
      assert.ok(keyUnavailable(error));
      assert.match(error.message, /another master key/);
      assert.match(error.message, /TOKEN_ENCRYPTION_KEY_PREVIOUS/);
      return true;
    });
    const rotated = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_B, MASTER_KEY_A)
    });
    assert.equal((await rotated.verifyKey()).status, 'verified');
  });

  it('refuses a key check object that was changed or replaced', async () => {
    const { store, inner } = storeOver();
    await store.verifyKey();
    inner.objects.set(marker, Buffer.from('{"format":1}'));
    await assert.rejects(store.verifyKey(), corrupt);
  });

  it('refuses a store that holds objects but no key check object, unless adopted', async () => {
    const { store, inner } = storeOver();
    const hasOtherObjects = async () => true;
    await assert.rejects(store.verifyKey({ hasOtherObjects }), {
      code: 'KEY_CHECK_MISSING'
    });
    await assert.rejects(store.verifyKey({ hasOtherObjects, create: false }), {
      code: 'KEY_CHECK_MISSING'
    });
    assert.equal(inner.objects.has(marker), false);

    assert.equal((await store.verifyKey({ hasOtherObjects, adopt: true })).status, 'adopted');
    assert.equal(inner.objects.has(marker), true);
  });

  it('fails without a master key before touching the store', async () => {
    const inner = new MemoryBlobStore();
    const store = new EncryptingBlobStore({ inner, keyProvider: providerOf(null) });
    await assert.rejects(store.verifyKey(), keyUnavailable);
    assert.equal(inner.gets, 0);
  });
});

describe('EncryptingBlobStore: encryption off and mixed stores', () => {
  const PLAIN = Buffer.from(
    'a plaintext blob, long enough to be as long as an envelope. '.repeat(20)
  );

  it('with encryption off, stores payloads as they are and still decrypts older blobs', async () => {
    const inner = new MemoryBlobStore();
    const encrypting = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A) });
    await encrypting.verifyKey();
    await encrypting.put(NS, 'old', 'written while encryption was on');

    const off = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_A),
      encryptWrites: false
    });
    assert.equal(off.encryptsWrites, false);
    assert.equal(off.acceptsPlaintext, true);
    assert.equal(await off.detectEnvelopes(), true, 'the key check object says envelopes exist');

    const ref = await off.put(NS, 'new', PLAIN);
    assert.deepEqual(ref, {
      key: 'new',
      bytes: PLAIN.length,
      sha256: crypto.createHash('sha256').update(PLAIN).digest('hex')
    });
    assert.ok(inner.objects.get(`${NS}/new`).equals(PLAIN), 'stored as it is');
    assert.ok((await off.get(NS, 'new')).data.equals(PLAIN));
    assert.equal((await off.get(NS, 'old')).data.toString(), 'written while encryption was on');
    assert.deepEqual((await off.list(NS)).items, [
      { key: 'new', bytes: PLAIN.length },
      { key: 'old', bytes: 31 }
    ]);
    await assert.rejects(off.verifyKey(), { code: 'NOT_SUPPORTED' });
  });

  it('with encryption off and no envelope ever written, passes everything through untouched', async () => {
    const inner = new MemoryBlobStore();
    const off = new EncryptingBlobStore({
      inner,
      keyProvider: () => {
        throw new Error('no key is needed');
      },
      encryptWrites: false
    });
    assert.equal(await off.detectEnvelopes(), false);
    // Even bytes that look like an envelope are a payload here.
    const lookalike = Buffer.concat([Buffer.from('IHB1\x01'), Buffer.alloc(700)]);
    await off.put(NS, 'lookalike', lookalike);
    await off.put(NS, 'plain', PLAIN);
    inner.gets = 0;
    assert.deepEqual((await off.list(NS)).items, [
      { key: 'lookalike', bytes: lookalike.length },
      { key: 'plain', bytes: PLAIN.length }
    ]);
    assert.equal(inner.gets, 0, 'a listing reads nothing');
    assert.ok((await off.get(NS, 'lookalike')).data.equals(lookalike));
  });

  it('still fails closed on a damaged envelope when plaintext is accepted', async () => {
    const inner = new MemoryBlobStore();
    const strict = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A) });
    await strict.put(NS, 'k', PLAIN);
    const damaged = Buffer.from(inner.objects.get(`${NS}/k`));
    damaged[damaged.length - 1] ^= 1;
    inner.objects.set(`${NS}/k`, damaged);
    for (const options of [{ plaintextReads: 'accept' }, { encryptWrites: false }]) {
      const lenient = new EncryptingBlobStore({
        inner,
        keyProvider: providerOf(MASTER_KEY_A),
        ...options
      });
      await assert.rejects(lenient.get(NS, 'k'), corrupt, JSON.stringify(options));
      const otherKey = new EncryptingBlobStore({
        inner,
        keyProvider: providerOf(MASTER_KEY_B),
        ...options
      });
      await assert.rejects(otherKey.get(NS, 'k'), keyUnavailable, JSON.stringify(options));
    }
  });

  it('while converting: writes encrypted, reads both, and lists both with payload sizes', async () => {
    const inner = new MemoryBlobStore();
    inner.objects.set(`${NS}/before-long`, Buffer.from(PLAIN));
    inner.objects.set(`${NS}/before-short`, Buffer.from('short'));
    // A plaintext blob whose length is no possible envelope length.
    const odd = Buffer.alloc(512 + ENVELOPE_SEGMENT_BYTES + 5, 0x41);
    inner.objects.set(`${NS}/before-odd`, odd);
    const store = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_A),
      plaintextReads: 'accept'
    });
    await store.put(NS, 'after', PLAIN);
    assert.equal(inner.objects.get(`${NS}/after`).toString('ascii', 0, 4), 'IHB1');

    assert.ok((await store.get(NS, 'before-long')).data.equals(PLAIN));
    assert.equal((await store.get(NS, 'before-short')).data.toString(), 'short');
    assert.ok((await store.get(NS, 'after')).data.equals(PLAIN));

    inner.gets = 0;
    assert.deepEqual((await store.list(NS)).items, [
      { key: 'after', bytes: PLAIN.length },
      { key: 'before-long', bytes: PLAIN.length },
      { key: 'before-odd', bytes: odd.length },
      { key: 'before-short', bytes: 5 }
    ]);
    // The store has no `readHead`, so the two objects long enough to be an
    // envelope were read; the other two were decided by their length.
    assert.equal(inner.gets, 2);
    assert.throws(
      () =>
        new EncryptingBlobStore({
          inner,
          keyProvider: providerOf(MASTER_KEY_A),
          plaintextReads: 'x'
        }),
      { code: 'INVALID_PROVIDER' }
    );
  });
});

describe('encryptExistingBlobs', () => {
  it('encrypts plaintext blobs in place, skips encrypted ones, and can be run again', async () => {
    const { encryptExistingBlobs } = await import('../storage/encryptExistingBlobs.js');
    const inner = new MemoryBlobStore();
    const payloads = {
      'chat-files/chat__a__1.txt': Buffer.from('first upload '.repeat(100)),
      'chat-files/chat__a__2.bin': crypto.randomBytes(3000),
      'artifacts/chat__a__art': Buffer.from('tiny'),
      'website-corpora/corpus__urls': Buffer.from('[]')
    };
    for (const [name, data] of Object.entries(payloads)) inner.objects.set(name, Buffer.from(data));
    const store = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_A),
      plaintextReads: 'accept'
    });
    await store.put('chat-files', 'chat__a__3.txt', 'already encrypted');

    const dry = await encryptExistingBlobs(store, { dryRun: true });
    assert.deepEqual(
      [dry.scanned, dry.encrypted, dry.alreadyEncrypted, dry.remaining],
      [5, 4, 1, 4]
    );
    assert.ok(
      inner.objects.get('artifacts/chat__a__art').equals(payloads['artifacts/chat__a__art'])
    );

    // Interrupted after two blobs.
    const controller = new AbortController();
    let seen = 0;
    const partial = await encryptExistingBlobs(store, {
      signal: controller.signal,
      onProgress: () => {
        seen += 1;
        if (seen === 2) controller.abort();
      }
    });
    assert.equal(partial.aborted, true);
    assert.ok(partial.encrypted >= 1 && partial.encrypted < 4);

    const rest = await encryptExistingBlobs(store);
    assert.equal(rest.aborted, false);
    assert.equal(rest.failed, 0);
    assert.equal(rest.remaining, 0);
    assert.equal(partial.encrypted + rest.encrypted, 4);
    assert.equal(rest.namespaces['chat-files'].scanned, 3);

    const again = await encryptExistingBlobs(store);
    assert.deepEqual([again.scanned, again.encrypted, again.alreadyEncrypted], [5, 0, 5]);

    // Every blob is an envelope now, so a strict store reads all of them.
    const strict = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A) });
    for (const [name, data] of Object.entries(payloads)) {
      const [ns, key] = name.split('/');
      assert.equal(inner.objects.get(name).toString('ascii', 0, 4), 'IHB1', name);
      assert.ok((await strict.get(ns, key)).data.equals(data), name);
    }
    assert.equal(
      (await strict.get('chat-files', 'chat__a__3.txt')).data.toString(),
      'already encrypted'
    );
  });

  it('counts a blob it could not encrypt and refuses a store that does not encrypt', async () => {
    const { encryptExistingBlobs } = await import('../storage/encryptExistingBlobs.js');
    const inner = new MemoryBlobStore();
    inner.objects.set('chat-files/k', Buffer.from('plain'));
    const noKey = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(null),
      plaintextReads: 'accept'
    });
    const result = await encryptExistingBlobs(noKey, { namespaces: ['chat-files'] });
    assert.deepEqual([result.failed, result.remaining, result.encrypted], [1, 1, 0]);
    assert.equal(inner.objects.get('chat-files/k').toString(), 'plain', 'left as it was');

    const off = new EncryptingBlobStore({
      inner,
      keyProvider: providerOf(MASTER_KEY_A),
      encryptWrites: false
    });
    await assert.rejects(encryptExistingBlobs(off), { code: 'NOT_SUPPORTED' });
  });
});
