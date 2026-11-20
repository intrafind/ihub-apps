// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The log seal `ihub-log-v1` (`crypto/logSeal.js`): the recorded format
 * vectors still open, and a record opens only in its stream, under its key
 * line and at its sequence number; a spill blob only at its stream and name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-log-seal-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
const keyModule = await import('../crypto/KeyProvider.js');
const seal = await import('../crypto/logSeal.js');
const { blobAssociatedData } = await import('../crypto/blobEnvelope.js');
const { fixedKeys, MASTER_KEY_A, MASTER_KEY_B } = await import('./support/blobTestSupport.js');

const vectors = JSON.parse(
  fs.readFileSync(new URL('./fixtures/log-seal/vectors.json', import.meta.url), 'utf8')
);
const keyProvider = fixedKeys(keyModule, { master: MASTER_KEY_A }).provider;
const tenant = 'default';
const stream = 'run:run-1';

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('log seal: recorded format vectors', () => {
  for (const vector of vectors.streams) {
    it(`opens the records of ${vector.stream} as recorded`, async () => {
      assert.equal(vectors.masterKey, MASTER_KEY_A);
      assert.equal(
        seal.logKeyAssociatedData({ tenant, stream: vector.stream, id: vector.keyLine.id }),
        vector.keyAssociatedData
      );
      const dataKey = await seal.openBatchKey({
        keyProvider,
        tenant,
        stream: vector.stream,
        line: vector.keyLine
      });
      for (const { record, line, associatedData } of vector.records) {
        assert.equal(
          seal.logRecordAssociatedData({
            tenant,
            stream: vector.stream,
            id: line.k,
            seq: line.seq
          }),
          associatedData
        );
        assert.deepEqual(seal.openRecord({ dataKey, tenant, stream: vector.stream, line }), record);
      }
    });
  }

  it('opens the recorded spill blob', async () => {
    const { spillBlob } = vectors;
    const stored = Buffer.from(spillBlob.storedBase64, 'base64');
    assert.equal(seal.isLogBlobEnvelope(stored), true);
    assert.equal(stored.toString('ascii', 0, 4), 'IHB1');
    assert.equal(
      seal.logBlobAssociatedData({ tenant, stream: spillBlob.stream, name: spillBlob.name }),
      spillBlob.associatedData
    );
    const plain = await seal.openLogBlob({
      keyProvider,
      tenant,
      stream: spillBlob.stream,
      name: spillBlob.name,
      stored
    });
    assert.equal(plain.toString('base64'), spillBlob.plainBase64);
  });

  it('builds the associated data as recorded in the design', () => {
    assert.equal(
      seal.logKeyAssociatedData({ tenant, stream, id: '00112233aabbccdd' }),
      '["ihub/log-key/v1","default","run:run-1","00112233aabbccdd"]'
    );
    assert.equal(
      seal.logRecordAssociatedData({ tenant, stream, id: '00112233aabbccdd', seq: 42 }),
      '["ihub/log/v1","default","run:run-1","00112233aabbccdd",42]'
    );
    assert.equal(
      seal.logBlobAssociatedData({ tenant, stream, name: 'tool-1.json' }),
      'ihub/logblob/v1\ndefault\nrun:run-1\ntool-1.json\n1048576'
    );
    // Never the associated data of a namespace blob with the same parts.
    assert.notEqual(
      seal.logBlobAssociatedData({ tenant, stream: 'run', name: 'x' }),
      blobAssociatedData({ tenant, ns: 'run', key: 'x' })
    );
  });
});

describe('log seal: records', () => {
  const newBatch = (target = stream) => seal.newBatchKey({ keyProvider, tenant, stream: target });
  const record = { type: 'message/user', data: { content: 'MARKER-CONTENT' }, seq: 5 };
  const sealIn = (batch, target = stream, seq = record.seq) =>
    seal.sealRecord({
      dataKey: batch.dataKey,
      tenant,
      stream: target,
      id: batch.id,
      seq,
      json: JSON.stringify({ ...record, seq })
    });

  it('round-trips a record; the line shows the seq and nothing of the record', async () => {
    const batch = await newBatch();
    const line = sealIn(batch);
    assert.deepEqual(Object.keys(line), ['$enc', 'seq', 'k', 'c']);
    assert.deepEqual(Object.keys(batch.line), ['$key', 'id', 'kp', 'kid', 'wk']);
    assert.equal(seal.isSealedLine(line) && seal.isWellFormedSealedLine(line), true);
    assert.equal(seal.isKeyLine(batch.line) && seal.isWellFormedKeyLine(batch.line), true);
    assert.equal(JSON.stringify(line).includes('MARKER-CONTENT'), false);
    assert.equal(JSON.stringify(line).includes('message/user'), false);
    const dataKey = await seal.openBatchKey({ keyProvider, tenant, stream, line: batch.line });
    assert.deepEqual(seal.openRecord({ dataKey, tenant, stream, line }), record);
  });

  it('gives the same record a new ciphertext every time (a repeated seq repeats no nonce)', async () => {
    const batch = await newBatch();
    assert.notEqual(sealIn(batch).c, sealIn(batch).c);
  });

  it('does not open a record moved to another seq', async () => {
    const batch = await newBatch();
    const line = sealIn(batch);
    assert.throws(
      () => seal.openRecord({ dataKey: batch.dataKey, tenant, stream, line: { ...line, seq: 6 } }),
      { code: 'VERIFY_FAILED' }
    );
  });

  it('does not open a record moved to another stream, with or without its key line', async () => {
    const batch = await newBatch();
    const line = sealIn(batch);
    // The record alone, under the data key, in another stream.
    assert.throws(
      () => seal.openRecord({ dataKey: batch.dataKey, tenant, stream: 'run:run-2', line }),
      { code: 'VERIFY_FAILED' }
    );
    // The key line copied along: its wrap is bound to the stream as well.
    await assert.rejects(
      seal.openBatchKey({ keyProvider, tenant, stream: 'run:run-2', line: batch.line }),
      { name: 'KeyAccessDenied', reason: 'unwrap-failed' }
    );
  });

  it('does not open a record under another key line of the same stream', async () => {
    const [one, two] = [await newBatch(), await newBatch()];
    const line = sealIn(one);
    assert.throws(
      () => seal.openRecord({ dataKey: two.dataKey, tenant, stream, line: { ...line, k: two.id } }),
      { code: 'VERIFY_FAILED' }
    );
    // The right key, but the line renamed to another key id.
    assert.throws(
      () => seal.openRecord({ dataKey: one.dataKey, tenant, stream, line: { ...line, k: two.id } }),
      { code: 'VERIFY_FAILED' }
    );
  });

  it('does not open a record whose inner seq differs from the line', async () => {
    const batch = await newBatch();
    const forged = seal.sealRecord({
      dataKey: batch.dataKey,
      tenant,
      stream,
      id: batch.id,
      seq: 9,
      json: JSON.stringify({ ...record, seq: 5 })
    });
    assert.throws(() => seal.openRecord({ dataKey: batch.dataKey, tenant, stream, line: forged }), {
      code: 'VERIFY_FAILED'
    });
  });

  it('does not open a changed record, a changed key line or another master key', async () => {
    const batch = await newBatch();
    const line = sealIn(batch);
    const bytes = Buffer.from(line.c, 'base64');
    bytes[bytes.length - 1] ^= 1;
    assert.throws(
      () =>
        seal.openRecord({
          dataKey: batch.dataKey,
          tenant,
          stream,
          line: { ...line, c: bytes.toString('base64') }
        }),
      { code: 'VERIFY_FAILED' }
    );
    const other = fixedKeys(keyModule, { master: MASTER_KEY_B }).provider;
    await assert.rejects(
      seal.openBatchKey({ keyProvider: other, tenant, stream, line: batch.line }),
      { name: 'KeyAccessDenied', reason: 'unknown-key' }
    );
    await assert.rejects(
      seal.openBatchKey({ keyProvider, tenant, stream, line: { ...batch.line, kp: 'transit' } }),
      { code: 'KEY_PROVIDER_MISMATCH' }
    );
    await assert.rejects(
      seal.openBatchKey({ keyProvider, tenant, stream, line: { ...batch.line, id: 'short' } }),
      { code: 'MALFORMED' }
    );
  });

  it('tells the line kinds apart by own properties only', () => {
    assert.equal(seal.isSealedLine({ type: 'x', seq: 1 }), false);
    assert.equal(seal.isKeyLine({ type: 'x', seq: 1 }), false);
    assert.equal(seal.isSealedLine(Object.create({ $enc: 1 })), false);
    assert.equal(seal.isSealedLine({ $enc: 2 }), false);
    assert.equal(seal.hasReservedProperty({ $enc: 0 }), true);
    assert.equal(seal.hasReservedProperty({ $key: 'x' }), true);
    assert.equal(seal.hasReservedProperty({ data: { $enc: 1 } }), false);
    assert.equal(seal.hasReservedProperty(null), false);
  });
});

describe('log seal: spill blobs', () => {
  const name = 'tool-1.json';
  const plain = Buffer.from('MARKER-SPILL '.repeat(100));

  it('round-trips and does not open at another stream or name', async () => {
    const stored = await seal.sealLogBlob({ keyProvider, tenant, stream, name, plain });
    assert.equal(stored.includes(Buffer.from('MARKER-SPILL')), false);
    assert.equal(seal.isLogBlobEnvelope(stored), true);
    const open = overrides =>
      seal.openLogBlob({ keyProvider, tenant, stream, name, stored, ...overrides });
    assert.ok((await open()).equals(plain));
    await assert.rejects(open({ stream: 'run:run-2' }), { name: 'KeyAccessDenied' });
    await assert.rejects(open({ name: 'tool-2.json' }), { name: 'KeyAccessDenied' });
    const changed = Buffer.from(stored);
    changed[changed.length - 1] ^= 1;
    await assert.rejects(open({ stored: changed }), { code: 'VERIFY_FAILED' });
  });

  it('does not take plaintext for an envelope', () => {
    assert.equal(seal.isLogBlobEnvelope(plain), false);
    assert.equal(seal.isLogBlobEnvelope(Buffer.from('IHB1 but short')), false);
    assert.equal(seal.isLogBlobEnvelope(Buffer.alloc(0)), false);
  });
});
