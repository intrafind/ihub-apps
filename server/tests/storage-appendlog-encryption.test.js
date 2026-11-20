// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sealed append logs on the filesystem provider: records are sealed when a
 * batch is flushed (one key line per batch), spill blobs with the blob
 * envelope. Covers what is on disk, the three modes, mixed files, the
 * reserved properties and what a writer of the data directory cannot do.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_KEY_B } from './support/blobTestSupport.js';
import { findReadable, providerInMode, testKeys } from './support/atRestTestSupport.js';

const STREAM = 'run:run-1';
const event = (seq, content = `MARKER-EVENT ${seq}`) => ({
  ts: '2026-11-19T10:00:00.000Z',
  runId: 'run-1',
  type: 'message/assistant',
  data: { content }
});

let baseDir;
let open = [];

async function start(mode, options) {
  const provider = providerInMode(baseDir, mode, options);
  await provider.initialize();
  open.push(provider);
  return provider;
}

const streamFile = (name = 'run-1') => path.join(baseDir, 'logs', 'run', `${name}.jsonl`);
const blobFile = (name, stream = 'run-1') =>
  path.join(baseDir, 'logs', 'run', `${stream}.blobs`, name);
const readLines = async file =>
  (await fs.readFile(file ?? streamFile(), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
const writeLines = (lines, file) =>
  fs.writeFile(file ?? streamFile(), lines.map(line => JSON.stringify(line)).join('\n') + '\n');

/** Append `count` events from `from` and flush them as one batch. */
async function appendBatch(logs, from, count, stream = STREAM) {
  for (let seq = from; seq < from + count; seq += 1) await logs.append(stream, event(seq), seq);
  await logs.flush();
}

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-log-enc-'));
  open = [];
});

afterEach(async () => {
  for (const provider of open) await provider.shutdown();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('sealed append log: what is on disk', () => {
  it('writes one key line per flushed batch, then its sealed records with a readable seq', async () => {
    const { logs } = await start('enforced');
    await appendBatch(logs, 1, 3);
    await appendBatch(logs, 4, 2);
    const lines = await readLines();
    assert.deepEqual(
      lines.map(line => (line.$key ? 'key' : `enc:${line.seq}`)),
      ['key', 'enc:1', 'enc:2', 'enc:3', 'key', 'enc:4', 'enc:5']
    );
    assert.notEqual(lines[0].id, lines[4].id, 'a fresh key per batch');
    assert.deepEqual(
      lines.slice(1, 4).map(line => line.k),
      Array(3).fill(lines[0].id)
    );
    assert.deepEqual(await findReadable(baseDir, ['MARKER-EVENT', 'message/assistant']), []);
  });

  it('reads back in seq order, pages with afterSeq and limit, and answers lastSeq and lastRecord', async () => {
    const { logs } = await start('enforced');
    await logs.append(STREAM, event(3), 3);
    await logs.append(STREAM, event(1), 1);
    await logs.flush();
    await logs.append(STREAM, event(2), 2);
    assert.deepEqual(
      (await logs.read(STREAM)).map(record => record.seq),
      [1, 2, 3]
    );
    assert.deepEqual(await logs.read(STREAM, { afterSeq: 1, limit: 1 }), [{ ...event(2), seq: 2 }]);
    assert.equal(await logs.lastSeq(STREAM), 3);
    assert.deepEqual(await logs.lastRecord(STREAM), { ...event(3), seq: 3 });
    assert.equal(await logs.lastRecord('run:none'), null);
  });

  it('survives a restart: a new provider reads what the previous one sealed', async () => {
    const first = await start('enforced');
    await appendBatch(first.logs, 1, 2);
    await first.shutdown();
    const { logs } = await start('enforced');
    assert.equal(await logs.lastSeq(STREAM), 2);
    await appendBatch(logs, 3, 1);
    assert.deepEqual(
      (await logs.read(STREAM)).map(record => record.data.content),
      ['MARKER-EVENT 1', 'MARKER-EVENT 2', 'MARKER-EVENT 3']
    );
  });

  it('binds one file to one stream id whichever way the stream is spelled', async () => {
    const { logs } = await start('enforced');
    await logs.append('plain', event(1), 1);
    await logs.append('_:plain', event(2), 2);
    assert.deepEqual(
      (await logs.read('plain')).map(record => record.seq),
      [1, 2]
    );
    assert.deepEqual(
      (await logs.read('_:plain')).map(record => record.seq),
      [1, 2]
    );
  });
});

describe('sealed append log: reserved properties', () => {
  for (const mode of ['off', 'converting', 'enforced']) {
    it(`refuses a record with "$enc" or "$key" in mode ${mode}`, async () => {
      const { logs } = await start(mode);
      await assert.rejects(logs.append(STREAM, { $enc: 1, seq: 1, k: 'x', c: 'y' }, 1), {
        code: 'INVALID_DATA'
      });
      await assert.rejects(logs.append(STREAM, { type: 'x', $key: 0 }, 1), {
        code: 'INVALID_DATA'
      });
      await assert.rejects(
        logs.appendBatch(STREAM, [
          { entry: event(1), seq: 1 },
          { entry: { $enc: 1 }, seq: 2 }
        ]),
        { code: 'INVALID_DATA' }
      );
      assert.deepEqual(await logs.read(STREAM), [], 'nothing of the batch was queued');
      // Nested, they are data like any other.
      await logs.append(STREAM, { type: 'x', data: { $enc: 1, $key: 1 } }, 1);
      assert.deepEqual((await logs.read(STREAM))[0].data, { $enc: 1, $key: 1 });
    });
  }
});

describe('sealed append log: the three modes and mixed files', () => {
  it('one file with plaintext and sealed records reads whole while converting and with the switch off', async () => {
    await appendBatch((await start('off')).logs, 1, 2);
    await appendBatch((await start('converting')).logs, 3, 2);
    await appendBatch((await start('off')).logs, 5, 1);
    const kinds = (await readLines()).map(line =>
      line.$key ? 'key' : line.$enc ? 'enc' : 'plain'
    );
    assert.deepEqual(kinds, ['plain', 'plain', 'key', 'enc', 'enc', 'plain']);
    for (const mode of ['off', 'converting']) {
      const { logs } = await start(mode);
      assert.deepEqual(
        (await logs.read(STREAM)).map(record => record.seq),
        [1, 2, 3, 4, 5],
        mode
      );
      assert.deepEqual(await logs.lastRecord(STREAM), { ...event(5), seq: 5 }, mode);
    }
  });

  it('enforced: a plaintext record is CORRUPT_LOG, an unparseable line is still skipped', async () => {
    const { logs } = await start('enforced');
    await appendBatch(logs, 1, 2);
    await fs.appendFile(streamFile(), '{"$enc":1,"seq":3,"k":"torn');
    assert.deepEqual(
      (await logs.read(STREAM)).map(record => record.seq),
      [1, 2]
    );
    await fs.appendFile(streamFile(), `\n${JSON.stringify({ ...event(9), seq: 9 })}\n`);
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG', name: 'CorruptLogError' });
    await assert.rejects(logs.lastSeq(STREAM), { code: 'CORRUPT_LOG' });
  });

  it('switch off after on: new records are plaintext, sealed ones are still read', async () => {
    await appendBatch((await start('enforced')).logs, 1, 2);
    const { logs } = await start('off');
    await appendBatch(logs, 3, 1);
    assert.equal((await readLines()).at(-1).type, 'message/assistant');
    assert.deepEqual(
      (await logs.read(STREAM)).map(record => record.seq),
      [1, 2, 3]
    );
  });

  it('with the master key gone: reads fail with KEY_UNAVAILABLE, writes stay queued and are not written in plaintext', async () => {
    await appendBatch((await start('enforced')).logs, 1, 2);
    const off = await start('off', { keys: testKeys({ master: null }) });
    await assert.rejects(off.logs.read(STREAM), { code: 'KEY_UNAVAILABLE' });
    const other = await start('enforced', { keys: testKeys({ master: MASTER_KEY_B }) });
    await assert.rejects(other.logs.read(STREAM), { code: 'KEY_UNAVAILABLE' });

    let available = false;
    const flaky = await start('enforced', {
      keys: {
        ensureMasterKey: async () => ({ initialized: available }),
        getKeyProvider: () => testKeys({ master: available ? undefined : null }).provider
      }
    });
    await flaky.logs.append('run:run-2', event(1), 1);
    await assert.rejects(flaky.logs.flush(), { code: 'KEY_UNAVAILABLE' });
    await assert.rejects(fs.stat(streamFile('run-2')), { code: 'ENOENT' });
    // The key comes back: the queued record is written, sealed, and readable.
    available = true;
    assert.deepEqual(
      (await flaky.logs.read('run:run-2')).map(record => record.seq),
      [1]
    );
    assert.equal((await fs.readFile(streamFile('run-2'), 'utf8')).includes('MARKER'), false);
  });
});

describe('sealed append log: what a writer of the data directory cannot do', () => {
  /** Two sealed streams with two batches each. */
  async function twoStreams() {
    const { logs } = await start('enforced');
    for (const stream of [STREAM, 'run:run-2']) {
      await appendBatch(logs, 1, 2, stream);
      await appendBatch(logs, 3, 2, stream);
    }
    return logs;
  }

  it('a changed record or a changed key line fails the read, it is not skipped', async () => {
    const logs = await twoStreams();
    const lines = await readLines();
    const changed = Buffer.from(lines[1].c, 'base64');
    changed[changed.length - 1] ^= 1;
    await writeLines([lines[0], { ...lines[1], c: changed.toString('base64') }, ...lines.slice(2)]);
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG' });
    // Records the caller does not ask for are not opened.
    assert.deepEqual(
      (await logs.read(STREAM, { afterSeq: 1 })).map(record => record.seq),
      [2, 3, 4]
    );

    const wrapped = Buffer.from(lines[0].wk, 'base64');
    wrapped[20] ^= 1;
    await writeLines([{ ...lines[0], wk: wrapped.toString('base64') }, ...lines.slice(1)]);
    await assert.rejects(logs.read(STREAM, { limit: 1 }), { code: 'CORRUPT_LOG' });
    assert.deepEqual(
      (await logs.read(STREAM, { afterSeq: 2 })).map(record => record.seq),
      [3, 4]
    );
  });

  it('a record moved to another seq fails the read', async () => {
    const logs = await twoStreams();
    const lines = await readLines();
    await writeLines([...lines, { ...lines[1], seq: 99 }]);
    await assert.rejects(logs.lastRecord(STREAM), { code: 'CORRUPT_LOG' });
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG' });
  });

  it('a record moved to another stream fails the read, with or without its key line', async () => {
    const logs = await twoStreams();
    const [own, foreign] = [await readLines(), await readLines(streamFile('run-2'))];
    // The record alone: its key line is not in this file.
    await writeLines([...own, { ...foreign[1], seq: 50 }]);
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG' });
    // With its key line: the wrap is bound to the other stream.
    await writeLines([...own, foreign[0], { ...foreign[1], seq: 50 }]);
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG' });
    // A whole stream file put in place of another one.
    await fs.copyFile(streamFile('run-2'), streamFile());
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG' });
    assert.equal((await logs.read('run:run-2')).length, 4);
  });

  it('a record put under another key line of its own stream fails the read', async () => {
    const logs = await twoStreams();
    const lines = await readLines();
    const otherKey = lines[3];
    assert.equal(otherKey.$key, 1);
    await writeLines([...lines.slice(0, 1), { ...lines[1], k: otherKey.id }, ...lines.slice(2)]);
    await assert.rejects(logs.read(STREAM, { limit: 1 }), { code: 'CORRUPT_LOG' });
  });

  it('a removed key line or a malformed sealed line fails the read', async () => {
    const logs = await twoStreams();
    const lines = await readLines();
    await writeLines(lines.slice(1));
    await assert.rejects(logs.read(STREAM, { limit: 1 }), { code: 'CORRUPT_LOG' });
    await writeLines([...lines, { $enc: 1, seq: 'x', k: lines[0].id, c: 'AAAA' }]);
    await assert.rejects(logs.read(STREAM), { code: 'CORRUPT_LOG' });
  });

  it('reordered lines read the same; a duplicated line is returned twice', async () => {
    const logs = await twoStreams();
    const lines = await readLines();
    await writeLines([...lines].reverse());
    assert.deepEqual(
      (await logs.read(STREAM)).map(record => record.seq),
      [1, 2, 3, 4]
    );
    await writeLines([...lines, lines[1]]);
    assert.deepEqual(
      (await logs.read(STREAM)).map(record => record.seq),
      [1, 1, 2, 3, 4]
    );
  });
});

describe('sealed append log: spill blobs', () => {
  const payload = Buffer.from('MARKER-SPILL tool result '.repeat(50));

  it('seals the blob and reports bytes and sha256 of the payload, as with the switch off', async () => {
    const plain = await (await start('off')).logs.putBlob(STREAM, 'plain.json', payload);
    const { logs } = await start('enforced');
    const sealed = await logs.putBlob(STREAM, 'sealed.json', payload, {
      contentType: 'application/json'
    });
    assert.equal(sealed.bytes, payload.length);
    assert.equal(sealed.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.deepEqual([sealed.bytes, sealed.sha256], [plain.bytes, plain.sha256]);
    const stored = await fs.readFile(blobFile('sealed.json'));
    assert.equal(stored.toString('ascii', 0, 4), 'IHB1');
    assert.equal(stored.includes(Buffer.from('MARKER-SPILL')), false);
    assert.ok((await logs.getBlob(STREAM, 'sealed.json')).equals(payload));
    assert.equal(await logs.getBlob(STREAM, 'missing'), null);
  });

  it('follows the three modes on read', async () => {
    await (await start('off')).logs.putBlob(STREAM, 'plain.json', payload);
    await (await start('converting')).logs.putBlob(STREAM, 'sealed.json', payload);
    for (const mode of ['off', 'converting']) {
      const { logs } = await start(mode);
      assert.ok((await logs.getBlob(STREAM, 'plain.json')).equals(payload), mode);
      assert.ok((await logs.getBlob(STREAM, 'sealed.json')).equals(payload), mode);
    }
    const { logs } = await start('enforced');
    await assert.rejects(logs.getBlob(STREAM, 'plain.json'), { code: 'CORRUPT_BLOB' });
    const missingKey = await start('off', { keys: testKeys({ master: null }) });
    await assert.rejects(missingKey.logs.getBlob(STREAM, 'sealed.json'), {
      code: 'KEY_UNAVAILABLE'
    });
  });

  it('a changed blob, or one moved to another stream or name, does not open', async () => {
    const { logs } = await start('enforced');
    await logs.putBlob(STREAM, 'a.json', payload);
    await logs.putBlob('run:run-2', 'a.json', payload);
    await fs.copyFile(blobFile('a.json'), blobFile('b.json'));
    await assert.rejects(logs.getBlob(STREAM, 'b.json'), { code: 'CORRUPT_BLOB' });
    await fs.copyFile(blobFile('a.json', 'run-2'), blobFile('a.json'));
    await assert.rejects(logs.getBlob(STREAM, 'a.json'), { code: 'CORRUPT_BLOB' });
    const stored = await fs.readFile(blobFile('a.json', 'run-2'));
    stored[stored.length - 1] ^= 1;
    await fs.writeFile(blobFile('a.json', 'run-2'), stored);
    await assert.rejects(logs.getBlob('run:run-2', 'a.json'), { code: 'CORRUPT_BLOB' });
  });

  it('with the switch off, a payload that itself looks like an envelope is stored sealed', async () => {
    const sealedElsewhere = await fs
      .readFile(new URL('./fixtures/log-seal/vectors.json', import.meta.url), 'utf8')
      .then(text => Buffer.from(JSON.parse(text).spillBlob.storedBase64, 'base64'));
    const { logs } = await start('off');
    const ref = await logs.putBlob(STREAM, 'looks-sealed', sealedElsewhere);
    assert.equal(ref.bytes, sealedElsewhere.length);
    assert.ok((await logs.getBlob(STREAM, 'looks-sealed')).equals(sealedElsewhere));
    assert.ok((await fs.readFile(blobFile('looks-sealed'))).length > sealedElsewhere.length);
  });

  it('deletes and sweeps sealed streams with their blobs as before', async () => {
    const { logs } = await start('enforced');
    await appendBatch(logs, 1, 1);
    await logs.putBlob(STREAM, 'a.json', payload);
    assert.equal(await logs.deleteStream(STREAM), true);
    assert.deepEqual(await logs.read(STREAM), []);
    await appendBatch(logs, 1, 1, 'run:old');
    await logs.putBlob('run:old', 'a.json', payload);
    assert.deepEqual(await logs.sweep({ olderThan: Date.now() + 60_000 }), {
      streams: 1,
      blobs: 1
    });
  });
});
