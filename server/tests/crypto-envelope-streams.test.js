// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The streaming side of `crypto/streamingAead.js` and
 * `crypto/envelopeStreams.js`: the same bytes as the buffered `encrypt` and
 * `decrypt`, a segment at a time. The format is fixed by the buffered
 * functions and the recorded vectors; these tests only ever compare with
 * them.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  blobAssociatedData,
  decodeHeader,
  encodeHeader,
  plainLength,
  storedLength
} from '../crypto/blobEnvelope.js';
import { createOpeningStream, createSealingStream } from '../crypto/envelopeStreams.js';
import {
  StreamingAeadError,
  ciphertextLength,
  createDecryptor,
  createEncryptor,
  decrypt,
  encrypt,
  newDataKey
} from '../crypto/streamingAead.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AAD = 'ihub/test/v1\nstream';

/** Cut a buffer into pieces of `size` bytes. */
function pieces(buffer, size) {
  const out = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    out.push(buffer.subarray(offset, offset + size));
  }
  return out;
}

/** Run a decryptor over pieces; returns what it handed out and what it threw. */
function decryptPieces(decryptor, chunks) {
  const out = [];
  try {
    for (const chunk of chunks) out.push(...decryptor.update(chunk));
    out.push(...decryptor.final());
    return { plain: Buffer.concat(out), error: null };
  } catch (error) {
    return { plain: Buffer.concat(out), error };
  }
}

/** Read a stream to its end; never rejects. */
async function drain(stream) {
  const chunks = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { data: Buffer.concat(chunks), error: null };
  } catch (error) {
    return { data: Buffer.concat(chunks), error };
  }
}

describe('streaming AEAD: a segment at a time', () => {
  // A small segment size makes every boundary cheap to hit; the format is
  // the same at 1 MiB.
  const SEGMENT = 1024;
  const FIRST = SEGMENT - 40 - 16;
  const NEXT = SEGMENT - 16;
  const SIZES = [0, 1, FIRST - 1, FIRST, FIRST + 1, FIRST + NEXT, FIRST + NEXT + 1, 5000];

  it('decrypts what encrypt wrote, whatever the size of the pieces', () => {
    const key = newDataKey();
    for (const size of SIZES) {
      const plain = crypto.randomBytes(size);
      const cipher = encrypt(plain, key, AAD, { segmentBytes: SEGMENT });
      for (const step of [1, 7, SEGMENT - 1, SEGMENT, SEGMENT + 1, 100_000]) {
        const result = decryptPieces(
          createDecryptor(key, AAD, { segmentBytes: SEGMENT }),
          pieces(cipher, step)
        );
        assert.equal(result.error, null, `size ${size}, pieces of ${step}`);
        assert.ok(result.plain.equals(plain), `size ${size}, pieces of ${step}`);
      }
    }
  });

  it('encrypts to what decrypt reads, with the length encrypt gives', () => {
    const key = newDataKey();
    for (const size of SIZES) {
      const plain = crypto.randomBytes(size);
      for (const step of [1, 7, FIRST, NEXT, 100_000]) {
        const encryptor = createEncryptor(key, AAD, { segmentBytes: SEGMENT });
        const out = [];
        for (const chunk of pieces(plain, step)) out.push(...encryptor.update(chunk));
        out.push(...encryptor.final());
        const cipher = Buffer.concat(out);
        assert.equal(cipher.length, ciphertextLength(size, SEGMENT), `size ${size}`);
        assert.ok(
          decrypt(cipher, key, AAD, { segmentBytes: SEGMENT }).equals(plain),
          `size ${size}, pieces of ${step}`
        );
      }
    }
  });

  it('hands out a segment only when it verified, and fails for every change', () => {
    const key = newDataKey();
    const plain = crypto.randomBytes(FIRST + 3 * NEXT + 100); // five segments
    const cipher = encrypt(plain, key, AAD, { segmentBytes: SEGMENT });
    const segment = index => [index * SEGMENT, Math.min(cipher.length, (index + 1) * SEGMENT)];
    /** Plaintext length of the first `count` segments. */
    const upTo = count => (count === 0 ? 0 : FIRST + (count - 1) * NEXT);
    const swapped = Buffer.from(cipher);
    cipher.copy(swapped, ...[SEGMENT, ...segment(2)]);
    cipher.copy(swapped, ...[2 * SEGMENT, ...segment(1)]);
    const flipped = (offset, source = cipher) => {
      const copy = Buffer.from(source);
      copy[offset] ^= 0x01;
      return copy;
    };
    const cases = [
      ['a byte flipped in the stream header', flipped(5), 0],
      ['a byte flipped in the first segment', flipped(100), 0],
      ['a byte flipped in the third segment', flipped(2 * SEGMENT + 9), 2],
      ['a byte flipped in the last tag', flipped(cipher.length - 1), 4],
      ['cut at a segment boundary', cipher.subarray(0, 3 * SEGMENT), 2],
      ['cut in the middle of a segment', cipher.subarray(0, 3 * SEGMENT + 17), 3],
      ['cut inside the last tag', cipher.subarray(0, cipher.length - 1), 4],
      ['two segments swapped', swapped, 1],
      ['a segment appended', Buffer.concat([cipher, cipher.subarray(...segment(3))]), 4],
      ['a byte appended', Buffer.concat([cipher, Buffer.from([0])]), 4]
    ];
    for (const [label, changed, goodSegments] of cases) {
      for (const step of [13, SEGMENT, 100_000]) {
        const result = decryptPieces(
          createDecryptor(key, AAD, { segmentBytes: SEGMENT }),
          pieces(changed, step)
        );
        assert.ok(result.error instanceof StreamingAeadError, `${label}: fails`);
        // Exactly the segments before the bad one, nothing of it or after it.
        assert.equal(result.plain.length, upTo(goodSegments), `${label}: what was handed out`);
        assert.ok(result.plain.equals(plain.subarray(0, upTo(goodSegments))), label);
        assert.throws(
          () => decrypt(changed, key, AAD, { segmentBytes: SEGMENT }),
          StreamingAeadError,
          `${label}: the buffered read fails too`
        );
      }
    }
  });

  it('fails for another key or other associated data, before any plaintext', () => {
    const key = newDataKey();
    const cipher = encrypt(crypto.randomBytes(3000), key, AAD, { segmentBytes: SEGMENT });
    for (const decryptor of [
      createDecryptor(newDataKey(), AAD, { segmentBytes: SEGMENT }),
      createDecryptor(key, `${AAD}x`, { segmentBytes: SEGMENT })
    ]) {
      const result = decryptPieces(decryptor, [cipher]);
      assert.ok(result.error instanceof StreamingAeadError);
      assert.equal(result.plain.length, 0);
    }
    assert.throws(() => createDecryptor(Buffer.alloc(5), AAD), StreamingAeadError);
    assert.throws(() => createDecryptor(key, ''), StreamingAeadError);
    assert.throws(() => createEncryptor(key, ''), StreamingAeadError);
  });

  it('is used up after final, and after a failure', () => {
    const key = newDataKey();
    const cipher = encrypt(Buffer.from('once'), key, AAD);
    const decryptor = createDecryptor(key, AAD);
    decryptor.update(cipher);
    decryptor.final();
    assert.throws(() => decryptor.update(cipher), StreamingAeadError);
    assert.throws(() => decryptor.final(), StreamingAeadError);
    const broken = createDecryptor(key, AAD);
    assert.throws(() => broken.final(), /too short/);
    assert.throws(() => broken.update(cipher), StreamingAeadError);
  });
});

describe('envelope streams', () => {
  const address = { tenant: 'default', ns: 'chat-files', key: 'chat__a__f1.bin' };
  const aad = blobAssociatedData(address);
  const header = encodeHeader({
    providerId: 'local-file',
    keyId: '0a1b2c3d',
    wrapped: crypto.randomBytes(61)
  });

  it('seals to the object the buffered encrypt lays out, at the 1 MiB boundaries', async () => {
    const first = ENVELOPE_SEGMENT_BYTES - 56;
    for (const size of [0, 1, first, first + 1, first + ENVELOPE_SEGMENT_BYTES - 16 + 5]) {
      const dataKey = newDataKey();
      const plain = crypto.randomBytes(size);
      const sealing = createSealingStream({ header, dataKey, aad, bytes: size });
      pipeline(Readable.from(pieces(plain, 65_537), { objectMode: false }), sealing, () => {});
      const { data: stored, error } = await drain(sealing);

      assert.equal(error, null);
      assert.equal(stored.length, storedLength(size), `size ${size}: stored length`);
      assert.equal(plainLength(stored.length), size);
      assert.ok(stored.subarray(0, ENVELOPE_HEADER_BYTES).equals(header));
      assert.deepEqual(decodeHeader(stored).keyId, '0a1b2c3d');
      assert.ok(decrypt(stored.subarray(ENVELOPE_HEADER_BYTES), dataKey, aad).equals(plain));
      assert.deepEqual(sealing.result(), {
        bytes: size,
        sha256: crypto.createHash('sha256').update(plain).digest('hex')
      });
    }
  });

  it('a sealing stream fails for a source of another length', async () => {
    for (const [declared, actual] of [
      [10, 9],
      [10, 11],
      [0, 1]
    ]) {
      const sealing = createSealingStream({
        header,
        dataKey: newDataKey(),
        aad,
        bytes: declared
      });
      pipeline(
        Readable.from([crypto.randomBytes(actual)], { objectMode: false }),
        sealing,
        () => {}
      );
      const { error } = await drain(sealing);
      assert.ok(error instanceof StreamingAeadError, `${actual} bytes for ${declared}`);
    }
  });

  it('opens what was sealed, and is ready only once the first segment verified', async () => {
    const dataKey = newDataKey();
    const plain = crypto.randomBytes(2 * ENVELOPE_SEGMENT_BYTES + 77);
    const stored = Buffer.concat([header, encrypt(plain, dataKey, aad)]);
    let sawHead = null;
    const opening = createOpeningStream({
      headBytes: ENVELOPE_HEADER_BYTES,
      begin: async head => {
        sawHead = head;
        return { dataKey: Buffer.from(dataKey), aad, expectedBytes: plain.length };
      }
    });
    pipeline(Readable.from(pieces(stored, 10_000), { objectMode: false }), opening, () => {});
    await opening.ready;
    assert.ok(sawHead.equals(header), 'begin sees exactly the head');
    const { data, error } = await drain(opening);
    assert.equal(error, null);
    assert.ok(data.equals(plain));
  });

  it('rejects ready, and hands out nothing, when the first segment does not verify', async () => {
    const dataKey = newDataKey();
    const stored = Buffer.concat([header, encrypt(crypto.randomBytes(3_000_000), dataKey, aad)]);
    stored[ENVELOPE_HEADER_BYTES + 500] ^= 0xff;
    const mapped = new Error('mapped');
    const opening = createOpeningStream({
      headBytes: ENVELOPE_HEADER_BYTES,
      begin: () => ({ dataKey: Buffer.from(dataKey), aad }),
      mapError: error => (error instanceof StreamingAeadError ? mapped : error)
    });
    const source = Readable.from(pieces(stored, 10_000), { objectMode: false });
    pipeline(source, opening, () => {});
    await assert.rejects(opening.ready, error => error === mapped);
    assert.equal(opening.readableLength, 0, 'nothing was handed out');
    assert.equal(source.destroyed, true, 'the source is released');
  });

  it('fails when the content verifies but has another length than announced', async () => {
    const dataKey = newDataKey();
    const stored = encrypt(Buffer.from('twelve bytes'), dataKey, aad);
    const opening = createOpeningStream({
      begin: () => ({ dataKey: Buffer.from(dataKey), aad, expectedBytes: 13 })
    });
    pipeline(Readable.from([stored], { objectMode: false }), opening, () => {});
    await assert.rejects(opening.ready, StreamingAeadError);
  });

  it('hands a passthrough object on as stored, head included, and what begin throws is the error', async () => {
    const stored = crypto.randomBytes(100_000);
    for (const size of [0, 5, ENVELOPE_HEADER_BYTES, stored.length]) {
      const opening = createOpeningStream({
        headBytes: ENVELOPE_HEADER_BYTES,
        begin: () => ({ passthrough: true })
      });
      pipeline(
        Readable.from(pieces(stored.subarray(0, size), 333), { objectMode: false }),
        opening,
        () => {}
      );
      await opening.ready;
      assert.ok((await drain(opening)).data.equals(stored.subarray(0, size)), `size ${size}`);
    }
    const refused = new Error('no key');
    const opening = createOpeningStream({
      headBytes: ENVELOPE_HEADER_BYTES,
      begin: async () => {
        throw refused;
      }
    });
    pipeline(Readable.from([stored], { objectMode: false }), opening, () => {});
    await assert.rejects(opening.ready, error => error === refused);
  });

  it('wipes the data key when it ends and when it is destroyed', async () => {
    const original = newDataKey();
    const stored = encrypt(crypto.randomBytes(3_000_000), original, aad);
    for (const leaveEarly of [false, true]) {
      const dataKey = Buffer.from(original);
      const opening = createOpeningStream({ begin: () => ({ dataKey, aad }) });
      pipeline(Readable.from(pieces(stored, 50_000), { objectMode: false }), opening, () => {});
      await opening.ready;
      if (leaveEarly) opening.destroy();
      else await drain(opening);
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(dataKey.equals(Buffer.alloc(32)), leaveEarly ? 'destroyed' : 'ended');
    }
  });
});

describe('envelope streams: recorded vectors', () => {
  it('opens every recorded object as a stream', async () => {
    const { LocalFileKeyProvider } = await import('../crypto/KeyProvider.js');
    const file = path.join(here, 'fixtures', 'blob-envelope', 'vectors.json');
    const { vectors } = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(vectors.length >= 5);
    for (const vector of vectors) {
      const stored = Buffer.from(vector.objectBase64, 'base64');
      const provider = new LocalFileKeyProvider({
        readMasterKey: () => vector.masterKeyHex,
        readPreviousKey: () => vector.previousKeyHex || null
      });
      for (const step of [1, 100, stored.length]) {
        const opening = createOpeningStream({
          headBytes: ENVELOPE_HEADER_BYTES,
          begin: async head => {
            const header = decodeHeader(head);
            return {
              dataKey: await provider.unwrap(header.wrapped, header.keyId, vector.associatedData),
              aad: vector.associatedData,
              expectedBytes: plainLength(stored.length)
            };
          }
        });
        pipeline(Readable.from(pieces(stored, step), { objectMode: false }), opening, () => {});
        const { data, error } = await drain(opening);
        assert.equal(error, null, vector.name);
        assert.equal(data.toString('base64'), vector.plaintextBase64, vector.name);
      }
    }
  });
});
