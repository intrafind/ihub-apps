// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Blob envelope v1 (`server/crypto/blobEnvelope.js`): the header layout, the
 * associated data string and the length arithmetic a listing depends on.
 *
 * The header length (512), the segment size (1 MiB) and the associated data
 * string are constants of the format. A change to any of them makes every
 * stored blob unreadable, so they are asserted literally here and through the
 * recorded vectors in `fixtures/blob-envelope/vectors.json`.
 */
import './support/scratchContents.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlobEnvelopeError,
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_MIN_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  blobAssociatedData,
  decodeHeader,
  encodeHeader,
  plainLength,
  storedLength
} from '../crypto/blobEnvelope.js';
import {
  StreamingAeadError,
  ciphertextLength,
  decrypt,
  encrypt,
  newDataKey,
  plaintextLength
} from '../crypto/streamingAead.js';
import { EncryptingBlobStore } from '../storage/EncryptingBlobStore.js';
import { MemoryBlobStore } from './support/blobTestSupport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPED = Buffer.alloc(61, 7);

/** First plaintext segment of the 1 MiB format: 1 MiB − header (40) − tag (16). */
const FIRST = ENVELOPE_SEGMENT_BYTES - 56;

describe('blob envelope: constants and associated data', () => {
  it('has the fixed header length, segment size and smallest object', () => {
    assert.equal(ENVELOPE_HEADER_BYTES, 512);
    assert.equal(ENVELOPE_SEGMENT_BYTES, 1024 * 1024);
    assert.equal(ENVELOPE_MIN_BYTES, 568);
  });

  it('builds the associated data as the exact newline-separated string', () => {
    assert.equal(
      blobAssociatedData({ tenant: 'default', ns: 'chat-files', key: 'chat__a__f1.txt' }),
      'ihub/blob/v1\ndefault\nchat-files\nchat__a__f1.txt\n1048576'
    );
  });

  it('refuses an address part that is missing or could hold a separator', () => {
    const good = { tenant: 'default', ns: 'ns', key: 'key' };
    for (const bad of [
      { tenant: undefined },
      { ns: '' },
      { key: null },
      { key: 'a\nb' },
      { ns: 'a/b' },
      { key: 'user@example.com' },
      { tenant: 'a b' }
    ]) {
      assert.throws(
        () => blobAssociatedData({ ...good, ...bad }),
        error => error instanceof BlobEnvelopeError && error.code === 'BAD_ADDRESS',
        JSON.stringify(bad)
      );
    }
    assert.throws(() => blobAssociatedData(), BlobEnvelopeError);
  });
});

describe('blob envelope: header', () => {
  it('round-trips the key fields in exactly 512 bytes, zero padded', () => {
    const header = encodeHeader({ providerId: 'local-file', keyId: 'ab12cd34', wrapped: WRAPPED });
    assert.equal(header.length, 512);
    assert.equal(header.toString('ascii', 0, 4), 'IHB1');
    assert.equal(header[4], 1);
    assert.deepEqual([header[5], header[6], header.readUInt16BE(7)], [10, 8, 61]);
    assert.ok(header.subarray(9 + 10 + 8 + 61).every(byte => byte === 0));
    assert.deepEqual(decodeHeader(header), {
      providerId: 'local-file',
      keyId: 'ab12cd34',
      wrapped: WRAPPED
    });
  });

  it('refuses fields that do not fit or are not ids', () => {
    const fields = { providerId: 'local-file', keyId: 'ab12cd34', wrapped: WRAPPED };
    for (const bad of [
      { providerId: '' },
      { providerId: 'with space' },
      { keyId: undefined },
      { keyId: 'ä' },
      { wrapped: Buffer.alloc(0) },
      { wrapped: 'text' },
      { wrapped: Buffer.alloc(600) }
    ]) {
      assert.throws(
        () => encodeHeader({ ...fields, ...bad }),
        error => error instanceof BlobEnvelopeError && error.code === 'MALFORMED_HEADER',
        JSON.stringify(Object.keys(bad))
      );
    }
  });

  it('refuses anything that is not a version 1 header, naming the reason', () => {
    const good = encodeHeader({ providerId: 'local-file', keyId: 'ab12cd34', wrapped: WRAPPED });
    const changed = (offset, value) => {
      const copy = Buffer.from(good);
      copy[offset] = value;
      return copy;
    };
    const cases = [
      [Buffer.from('plain text, not an envelope'), 'NOT_AN_ENVELOPE'],
      [Buffer.alloc(0), 'NOT_AN_ENVELOPE'],
      [Buffer.alloc(512), 'NOT_AN_ENVELOPE'],
      [Buffer.concat([Buffer.from('{"json":true}'), Buffer.alloc(600)]), 'NOT_AN_ENVELOPE'],
      [changed(0, 0x58), 'NOT_AN_ENVELOPE'],
      [changed(4, 2), 'UNKNOWN_VERSION'],
      [changed(5, 0), 'MALFORMED_HEADER'],
      [changed(6, 0), 'MALFORMED_HEADER'],
      [changed(7, 0xff), 'MALFORMED_HEADER'],
      [changed(511, 1), 'MALFORMED_HEADER'],
      [changed(9, 0x20), 'MALFORMED_HEADER']
    ];
    for (const [stored, code] of cases) {
      assert.throws(
        () => decodeHeader(stored),
        error => error instanceof BlobEnvelopeError && error.code === code,
        `${code} for ${stored.subarray(0, 12).toString('hex')}`
      );
    }
    assert.throws(() => decodeHeader(changed(4, 2)), /version 2/);
    assert.throws(() => decodeHeader('IHB1'), BlobEnvelopeError);
  });
});

describe('blob envelope: length arithmetic', () => {
  const SIZES = [
    0,
    1,
    15,
    16,
    17,
    FIRST - 1,
    FIRST,
    FIRST + 1,
    FIRST + ENVELOPE_SEGMENT_BYTES - 16
  ];

  it('computes the stored length the encryption really produces', () => {
    const key = newDataKey();
    for (const size of [...SIZES, 5 * 1024 * 1024]) {
      const cipher = encrypt(Buffer.alloc(size, 0x41), key, 'aad');
      assert.equal(cipher.length, ciphertextLength(size), `ciphertextLength(${size})`);
      assert.equal(storedLength(size), 512 + cipher.length, `storedLength(${size})`);
      assert.equal(plainLength(storedLength(size)), size, `plainLength of ${size}`);
    }
  });

  it('knows the boundaries: one segment up to 1 MiB − 56, a 17-byte second one after it', () => {
    assert.equal(storedLength(0), 568);
    assert.equal(storedLength(FIRST), 512 + ENVELOPE_SEGMENT_BYTES);
    assert.equal(storedLength(FIRST + 1), 512 + ENVELOPE_SEGMENT_BYTES + 17);
    // Exactly two full segments, then a third of one byte.
    const two = FIRST + ENVELOPE_SEGMENT_BYTES - 16;
    assert.equal(storedLength(two), 512 + 2 * ENVELOPE_SEGMENT_BYTES);
    assert.equal(storedLength(two + 1), 512 + 2 * ENVELOPE_SEGMENT_BYTES + 17);
  });

  it('agrees with small segment sizes too', () => {
    const key = newDataKey();
    for (const size of [0, 1, 71, 72, 73, 183, 184, 185, 300, 5000]) {
      const cipher = encrypt(Buffer.alloc(size), key, 'aad', { segmentBytes: 128 });
      assert.equal(ciphertextLength(size, 128), cipher.length, `size ${size}`);
      assert.equal(plaintextLength(cipher.length, 128), size, `size ${size}`);
    }
  });

  it('reserves leading bytes in front of an unchanged ciphertext', () => {
    const key = newDataKey();
    const plain = Buffer.from('a'.repeat(300));
    for (const size of [0, 1, 300]) {
      const stored = encrypt(plain.subarray(0, size), key, 'aad', {
        segmentBytes: 128,
        leadingBytes: 512
      });
      assert.equal(stored.length, 512 + ciphertextLength(size, 128), `size ${size}`);
      assert.ok(stored.subarray(0, 512).equals(Buffer.alloc(512)), 'the reserved bytes are zero');
      assert.ok(
        decrypt(stored.subarray(512), key, 'aad', { segmentBytes: 128 }).equals(
          plain.subarray(0, size)
        ),
        `size ${size}`
      );
    }
    for (const bad of [-1, 1.5, Number.NaN, '512']) {
      assert.throws(() => encrypt(plain, key, 'aad', { leadingBytes: bad }), StreamingAeadError);
    }
  });

  it('refuses a length no envelope has', () => {
    for (const bad of [
      0,
      511,
      567,
      -1,
      1.5,
      Number.NaN,
      '568',
      512 + ENVELOPE_SEGMENT_BYTES + 1,
      512 + ENVELOPE_SEGMENT_BYTES + 16
    ]) {
      assert.throws(
        () => plainLength(bad),
        error => error instanceof BlobEnvelopeError && error.code === 'BAD_LENGTH',
        `plainLength(${bad})`
      );
    }
    assert.throws(() => plaintextLength(55), StreamingAeadError);
    assert.throws(() => ciphertextLength(-1), StreamingAeadError);
    assert.throws(() => storedLength(1.5), StreamingAeadError);
  });
});

describe('blob envelope: recorded vectors', () => {
  it('opens every recorded object with the recorded master key', async () => {
    const { LocalFileKeyProvider } = await import('../crypto/KeyProvider.js');
    const file = path.join(here, 'fixtures', 'blob-envelope', 'vectors.json');
    const { envelope, vectors } = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(envelope, 'IHB1/v1');
    assert.ok(vectors.length >= 5);
    for (const vector of vectors) {
      const inner = new MemoryBlobStore();
      const stored = Buffer.from(vector.objectBase64, 'base64');
      inner.objects.set(`${vector.ns}/${vector.key}`, stored);
      const store = new EncryptingBlobStore({
        inner,
        tenant: vector.tenant,
        keyProvider: new LocalFileKeyProvider({
          readMasterKey: () => vector.masterKeyHex,
          readPreviousKey: () => vector.previousKeyHex || null
        })
      });
      const read = await store.get(vector.ns, vector.key);
      assert.equal(read.data.toString('base64'), vector.plaintextBase64, vector.name);
      assert.equal(plainLength(stored.length), read.bytes, `${vector.name}: length arithmetic`);
      assert.equal(vector.associatedData, blobAssociatedData(vector), vector.name);
    }
  });
});
