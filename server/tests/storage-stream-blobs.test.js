// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Streamed reads and writes of encrypted blobs and of sealed files
 * (`EncryptingBlobStore.openRead` / `putStream`,
 * `storage/atRest/sealedFiles.js#openSealedStream`).
 *
 * The rule under test: a stream hands out a segment only after it verified,
 * an object that is changed, cut or extended makes the stream fail with the
 * error `get` throws, and it never ends cleanly on such an object. Run over a
 * store that only has `get` (the base `openRead`) and over the filesystem
 * store (a real file stream); the S3 store has a file of its own.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFileKeyProvider } from '../crypto/KeyProvider.js';
import {
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  storedLength
} from '../crypto/blobEnvelope.js';
import { EncryptingBlobStore } from '../storage/EncryptingBlobStore.js';
import { encryptExistingBlobs } from '../storage/encryptExistingBlobs.js';
import {
  CorruptBlobError,
  CorruptDocumentError,
  KeyUnavailableError,
  StorageError
} from '../storage/errors.js';
import { FilesystemBlobStore } from '../storage/providers/filesystem/FilesystemBlobStore.js';
import * as sealedFiles from '../storage/atRest/sealedFiles.js';
import { MASTER_KEY_A, MASTER_KEY_B, MemoryBlobStore } from './support/blobTestSupport.js';
import { callRoute } from './support/httpRoute.js';
import { sendStream } from '../utils/streamResponse.js';

const NS = 'chat-files';
const SEGMENT = ENVELOPE_SEGMENT_BYTES;
/** Payload bytes in the first segment and in every further one. */
const FIRST = SEGMENT - 56;
const NEXT = SEGMENT - 16;
/** Four segments: three full ones and a short last one. */
const PAYLOAD = crypto.randomBytes(FIRST + 2 * NEXT + 1000);
/** Payload length of the first `count` segments. */
const upTo = count => (count === 0 ? 0 : FIRST + (count - 1) * NEXT);
/** Where segment `index` starts in the stored object. */
const segmentStart = index => ENVELOPE_HEADER_BYTES + index * SEGMENT;

const providerOf = (master, previous = null) =>
  new LocalFileKeyProvider({ readMasterKey: () => master, readPreviousKey: () => previous });

const corrupt = error => error instanceof CorruptBlobError && error.code === 'CORRUPT_BLOB';

/** Read a stream to its end; never rejects. `ended` says whether it ended cleanly. */
async function drain(stream) {
  const chunks = [];
  let ended = false;
  stream.once('end', () => {
    ended = true;
  });
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { data: Buffer.concat(chunks), error: null, ended };
  } catch (error) {
    return { data: Buffer.concat(chunks), error, ended };
  }
}

function streamOf(buffer, pieceBytes = 70_001) {
  const pieces = [];
  for (let offset = 0; offset < buffer.length; offset += pieceBytes) {
    pieces.push(buffer.subarray(offset, offset + pieceBytes));
  }
  return Readable.from(pieces, { objectMode: false });
}

let scratch;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-stream-blobs-'));
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/**
 * The inner stores the streams are checked over, each with direct access to
 * what is stored.
 */
const INNER_STORES = [
  {
    name: 'a store with get only (the base openRead)',
    async open() {
      const inner = new MemoryBlobStore();
      return {
        inner,
        read: async key => Buffer.from(inner.objects.get(`${NS}/${key}`)),
        write: async (key, data) => void inner.objects.set(`${NS}/${key}`, Buffer.from(data))
      };
    }
  },
  {
    name: 'the filesystem store (a file stream)',
    async open() {
      const dir = await fs.mkdtemp(path.join(scratch, 'fs-'));
      const inner = new FilesystemBlobStore(dir, { keyPrefixSegments: {} });
      const file = key => path.join(dir, 'blobs', NS, key);
      return {
        inner,
        read: key => fs.readFile(file(key)),
        write: async (key, data) => {
          await fs.mkdir(path.dirname(file(key)), { recursive: true });
          await fs.writeFile(file(key), data);
        }
      };
    }
  }
];

for (const kind of INNER_STORES) {
  describe(`streamed blobs over ${kind.name}`, () => {
    /** A fresh store holding PAYLOAD at `k`, and the stored object. */
    async function seeded(options = {}) {
      const raw = await kind.open();
      const store = new EncryptingBlobStore({
        inner: raw.inner,
        keyProvider: providerOf(MASTER_KEY_A),
        ...options
      });
      await store.put(NS, 'k', PAYLOAD);
      return { ...raw, store, stored: await raw.read('k') };
    }

    it('streams the payload with its size', async () => {
      const { store, stored } = await seeded();
      assert.equal(stored.length, storedLength(PAYLOAD.length));

      const opened = await store.openRead(NS, 'k');

      assert.equal(opened.bytes, PAYLOAD.length);
      const read = await drain(opened.stream);
      assert.equal(read.error, null);
      assert.equal(read.ended, true);
      assert.ok(read.data.equals(PAYLOAD));
    });

    it('rejects the open, with nothing handed out, when the object is unreadable from the start', async () => {
      const { store, stored, write } = await seeded();
      const flipped = offset => {
        const copy = Buffer.from(stored);
        copy[offset] ^= 0x01;
        return copy;
      };
      const cases = [
        ['a byte flipped in the wrapped key', flipped(40)],
        ['a byte flipped in the header padding', flipped(300)],
        ['a byte flipped in the stream header', flipped(ENVELOPE_HEADER_BYTES + 3)],
        ['a byte flipped in the first segment', flipped(segmentStart(0) + 5000)],
        ['a byte flipped in the first tag', flipped(segmentStart(1) - 1)],
        ['cut inside the first segment', stored.subarray(0, segmentStart(0) + 5000)],
        ['cut to the header', stored.subarray(0, ENVELOPE_HEADER_BYTES)],
        ['plaintext', Buffer.from('PLAINTEXT-CANARY '.repeat(100))],
        ['empty', Buffer.alloc(0)]
      ];
      for (const [label, object] of cases) {
        await write('k', object);
        await assert.rejects(store.openRead(NS, 'k'), corrupt, `${label}: openRead`);
        await assert.rejects(store.get(NS, 'k'), corrupt, `${label}: get agrees`);
      }
    });

    it('fails the stream, after exactly the segments before the bad one, and never ends it', async () => {
      const { store, stored, write } = await seeded();
      const flipped = offset => {
        const copy = Buffer.from(stored);
        copy[offset] ^= 0x01;
        return copy;
      };
      const swapped = Buffer.from(stored);
      stored.copy(swapped, segmentStart(1), segmentStart(2), segmentStart(3));
      stored.copy(swapped, segmentStart(2), segmentStart(1), segmentStart(2));
      // [what was done, the stored object, segments that are still genuine]
      const cases = [
        ['a byte flipped in the second segment', flipped(segmentStart(1) + 17), 1],
        ['a byte flipped in the third segment', flipped(segmentStart(2) + 700_000), 2],
        ['a byte flipped in the last segment', flipped(segmentStart(3) + 10), 3],
        ['a byte flipped in the last tag', flipped(stored.length - 1), 3],
        ['cut after the second segment', stored.subarray(0, segmentStart(2)), 1],
        ['cut after the third segment', stored.subarray(0, segmentStart(3)), 2],
        ['cut in the middle of the third segment', stored.subarray(0, segmentStart(2) + 4321), 2],
        ['cut inside the last tag', stored.subarray(0, stored.length - 3), 3],
        ['the second and third segment swapped', swapped, 1],
        [
          'a segment appended',
          Buffer.concat([stored, stored.subarray(segmentStart(1), segmentStart(2))]),
          3
        ],
        ['a byte appended', Buffer.concat([stored, Buffer.from([7])]), 3]
      ];
      for (const [label, object, genuine] of cases) {
        await write('k', object);
        await assert.rejects(store.get(NS, 'k'), corrupt, `${label}: get`);

        const opened = await store.openRead(NS, 'k');
        const read = await drain(opened.stream);

        assert.ok(corrupt(read.error), `${label}: the stream fails with CORRUPT_BLOB`);
        assert.equal(read.ended, false, `${label}: the stream did not end cleanly`);
        assert.equal(read.data.length, upTo(genuine), `${label}: what was handed out`);
        assert.ok(
          read.data.equals(PAYLOAD.subarray(0, upTo(genuine))),
          `${label}: only genuine segments were handed out`
        );
        assert.ok(read.data.length < PAYLOAD.length, `${label}: never the whole payload`);
      }
      await write('k', stored);
      assert.ok((await drain((await store.openRead(NS, 'k')).stream)).data.equals(PAYLOAD));
    });

    it('does not open an object moved to another key or read with another master key', async () => {
      const { store, stored, write, inner } = await seeded();
      await write('other', stored);
      await assert.rejects(store.openRead(NS, 'other'), corrupt);

      const stranger = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_B) });
      await assert.rejects(
        stranger.openRead(NS, 'k'),
        error => error instanceof KeyUnavailableError && error.code === 'KEY_UNAVAILABLE'
      );
      const rotated = new EncryptingBlobStore({
        inner,
        keyProvider: providerOf(MASTER_KEY_B, MASTER_KEY_A)
      });
      assert.ok((await drain((await rotated.openRead(NS, 'k')).stream)).data.equals(PAYLOAD));
    });

    it('follows the mode for a plaintext object exactly as get does', async () => {
      const plain = Buffer.concat([Buffer.from('not an envelope: '), crypto.randomBytes(70_000)]);
      for (const options of [
        { encryptWrites: true, plaintextReads: 'accept' },
        { encryptWrites: false }
      ]) {
        const { store, write } = await seeded(options);
        for (const object of [plain, plain.subarray(0, 10), Buffer.alloc(0)]) {
          await write('legacy', object);
          const opened = await store.openRead(NS, 'legacy');
          assert.equal(opened.bytes, object.length);
          assert.ok((await drain(opened.stream)).data.equals(object));
          assert.ok((await store.get(NS, 'legacy')).data.equals(object));
        }
        // An envelope is decrypted in every mode, and a damaged one is never
        // handed out as stored.
        await store.detectEnvelopes();
      }
      const off = await seeded({ encryptWrites: false });
      const sealedBy = new EncryptingBlobStore({
        inner: off.inner,
        keyProvider: providerOf(MASTER_KEY_A)
      });
      await sealedBy.put(NS, 'sealed', PAYLOAD);
      assert.ok(
        (await drain((await off.store.openRead(NS, 'sealed')).stream)).data.equals(PAYLOAD)
      );
      const damaged = await off.read('sealed');
      damaged[segmentStart(2) + 5] ^= 0x01;
      await off.write('sealed', damaged);
      const read = await drain((await off.store.openRead(NS, 'sealed')).stream);
      assert.ok(corrupt(read.error));
      assert.equal(read.data.length, upTo(2));
    });

    it('a reader that leaves early releases the inner stream', async () => {
      const { store, inner } = await seeded();
      const opens = [];
      const openRead = inner.openRead.bind(inner);
      inner.openRead = async (...args) => {
        const opened = await openRead(...args);
        if (opened) opens.push(opened.stream);
        return opened;
      };
      const opened = await store.openRead(NS, 'k');
      await new Promise(resolve => opened.stream.once('data', resolve));
      opened.stream.destroy();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(opens.length, 1);
      assert.equal(opens[0].destroyed, true, 'the stored object is no longer read');
    });

    it('putStream writes the object put writes, and nothing when it cannot', async () => {
      const { store, inner, read } = await seeded();
      const ref = await store.putStream(NS, 'streamed', streamOf(PAYLOAD), {
        bytes: PAYLOAD.length
      });
      assert.deepEqual(ref, {
        key: 'streamed',
        bytes: PAYLOAD.length,
        sha256: crypto.createHash('sha256').update(PAYLOAD).digest('hex')
      });
      const stored = await read('streamed');
      assert.equal(stored.length, storedLength(PAYLOAD.length));
      assert.equal(stored.toString('ascii', 0, 4), 'IHB1');
      assert.equal(stored.includes(PAYLOAD.subarray(0, 32)), false, 'the payload is not stored');
      assert.ok((await store.get(NS, 'streamed')).data.equals(PAYLOAD));

      const small = new EncryptingBlobStore({
        inner,
        keyProvider: providerOf(MASTER_KEY_A),
        maxBlobBytes: 1000
      });
      const tooLarge = streamOf(PAYLOAD);
      await assert.rejects(
        small.putStream(NS, 'big', tooLarge, { bytes: PAYLOAD.length }),
        error => error instanceof StorageError && error.code === 'BLOB_TOO_LARGE'
      );
      assert.equal(tooLarge.destroyed, true);
      assert.equal(await inner.get(NS, 'big'), null);

      const keyless = new EncryptingBlobStore({ inner, keyProvider: providerOf(null) });
      const source = streamOf(PAYLOAD);
      await assert.rejects(
        keyless.putStream(NS, 'nokey', source, { bytes: PAYLOAD.length }),
        error => error instanceof KeyUnavailableError
      );
      assert.equal(source.destroyed, true);
      assert.equal(await inner.get(NS, 'nokey'), null, 'no plaintext fallback');
    });

    it('the one-time encryption converts a large plaintext blob as a stream', async () => {
      const { store, write, read, inner } = await seeded({ plaintextReads: 'accept' });
      await write('legacy', PAYLOAD);
      const gets = [];
      const get = inner.get.bind(inner);
      inner.get = async (ns, key) => {
        gets.push(key);
        return get(ns, key);
      };
      const result = await encryptExistingBlobs(store, { namespaces: [NS] });
      assert.equal(result.encrypted, 1);
      assert.equal(result.failed, 0);
      assert.equal((await read('legacy')).toString('ascii', 0, 4), 'IHB1');
      inner.get = get;
      assert.ok((await store.get(NS, 'legacy')).data.equals(PAYLOAD));
      if (typeof inner.readHead === 'function') {
        assert.deepEqual(gets, [], 'no blob was read whole');
      }
    });
  });
}

describe('a blob stream that fails before anyone listens', () => {
  /** A store whose object `k` has a damaged second segment, delivered in one chunk. */
  async function damaged() {
    const inner = new MemoryBlobStore();
    const store = new EncryptingBlobStore({ inner, keyProvider: providerOf(MASTER_KEY_A) });
    await store.put(NS, 'k', PAYLOAD);
    inner.objects.get(`${NS}/k`)[segmentStart(1) + 5] ^= 0x01;
    return store;
  }

  it('does not throw into the process, and still fails for a reader that comes later', async () => {
    const store = await damaged();
    const opened = await store.openRead(NS, 'k');
    // Nobody reads and nobody listens while the stream runs into the damage.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(corrupt(opened.stream.errored), 'the failure is recorded on the stream');

    const read = await drain(opened.stream);
    assert.ok(corrupt(read.error));
    assert.equal(read.ended, false);
    assert.ok(read.data.length <= FIRST);
  });

  it('is answered with an error status by sendStream, never with a short success', async () => {
    const store = await damaged();
    const outcome = await callRoute([
      async (req, res) => {
        const opened = await store.openRead(NS, 'k');
        await new Promise(resolve => setTimeout(resolve, 30));
        await sendStream(req, res, opened.stream, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(opened.bytes),
            'Content-Disposition': 'attachment; filename="k.pdf"'
          }
        });
      }
    ]);
    assert.equal(outcome.status, 500);
    assert.match(outcome.headers['content-type'], /application\/problem\+json/);
    assert.equal(outcome.headers['content-disposition'], undefined, 'no header of the download');
    assert.notEqual(outcome.headers['content-length'], String(PAYLOAD.length));
  });

  it('sendStream ends a whole stream, and cuts one that fails after its first bytes', async () => {
    const store = await damaged();
    const whole = await callRoute([
      async (req, res) => {
        await sendStream(
          req,
          res,
          Readable.from([Buffer.from('all of it')], { objectMode: false }),
          {
            headers: { 'Content-Length': '9' }
          }
        );
      }
    ]);
    assert.equal(whole.status, 200);
    assert.equal(whole.complete, true);
    assert.equal(whole.body.toString(), 'all of it');

    const cut = await callRoute([
      async (req, res) => {
        const opened = await store.openRead(NS, 'k');
        await sendStream(req, res, opened.stream, {
          headers: { 'Content-Length': String(opened.bytes) }
        });
      }
    ]);
    assert.equal(cut.complete, false, 'the transfer must not end cleanly');
    assert.ok(cut.body.length <= FIRST);
    assert.ok(cut.body.equals(PAYLOAD.subarray(0, cut.body.length)));
  });
});

describe('sealed files as a stream', () => {
  const STORE = 'agent-artifacts';
  const CONTENT = Buffer.concat([
    Buffer.from('# Report\n'),
    crypto.randomBytes(FIRST + NEXT + 500)
  ]);
  const keys = providerOf(MASTER_KEY_A);
  const documentCorrupt = error =>
    error instanceof CorruptDocumentError && error.code === 'CORRUPT_DOCUMENT';
  let file;
  let sealed;

  before(async () => {
    sealedFiles.configureSealedFiles({ enabled: true, keyProvider: keys });
    file = path.join(scratch, 'report.md');
    sealed = await sealedFiles.sealForDisk(STORE, 'run1/report.md', CONTENT);
    await fs.writeFile(file, sealed);
  });

  after(() => {
    sealedFiles.resetSealedFiles();
  });

  it('opens a sealed file with the size of its content', async () => {
    const opened = await sealedFiles.openSealedStream(STORE, 'run1/report.md', file);
    assert.equal(opened.sealed, true);
    assert.equal(opened.bytes, CONTENT.length);
    const read = await drain(opened.stream);
    assert.equal(read.error, null);
    assert.ok(read.data.equals(CONTENT));
    assert.ok(
      (await sealedFiles.openFromDisk(STORE, 'run1/report.md', sealed)).equals(read.data),
      'the stream is what openFromDisk returns'
    );
  });

  it('rejects a file that does not open, and fails the stream for a later change', async () => {
    await assert.rejects(
      sealedFiles.openSealedStream(STORE, 'run1/other.md', file),
      documentCorrupt,
      'another name'
    );
    const early = Buffer.from(sealed);
    early[ENVELOPE_HEADER_BYTES + 900] ^= 0x01;
    await fs.writeFile(file, early);
    await assert.rejects(
      sealedFiles.openSealedStream(STORE, 'run1/report.md', file),
      documentCorrupt
    );

    for (const [label, object, genuine] of [
      [
        'a byte flipped in the last segment',
        (() => {
          const copy = Buffer.from(sealed);
          copy[copy.length - 100] ^= 0x01;
          return copy;
        })(),
        2
      ],
      ['cut after the second segment', sealed.subarray(0, segmentStart(2)), 1],
      ['cut in the middle of the second segment', sealed.subarray(0, segmentStart(1) + 99), 1]
    ]) {
      await fs.writeFile(file, object);
      const opened = await sealedFiles.openSealedStream(STORE, 'run1/report.md', file);
      const read = await drain(opened.stream);
      assert.ok(documentCorrupt(read.error), `${label}: ${read.error?.message}`);
      assert.equal(read.ended, false, label);
      assert.ok(read.data.equals(CONTENT.subarray(0, upTo(genuine))), label);
    }
    await fs.writeFile(file, sealed);
  });

  it('serves a plaintext file as it is until plaintext is refused, and reports a missing file', async () => {
    const plain = path.join(scratch, 'plain.md');
    await fs.writeFile(plain, '# Plain');
    const opened = await sealedFiles.openSealedStream(STORE, 'run1/plain.md', plain);
    assert.equal(opened.sealed, false);
    assert.equal(opened.bytes, 7);
    assert.equal((await drain(opened.stream)).data.toString(), '# Plain');

    sealedFiles.configureSealedFiles({
      enabled: true,
      keyProvider: keys,
      state: { state: 'complete', facets: { files: 1 } }
    });
    await assert.rejects(
      sealedFiles.openSealedStream(STORE, 'run1/plain.md', plain),
      error => error.code === 'PLAINTEXT_FILE'
    );
    await assert.rejects(
      sealedFiles.openSealedStream(STORE, 'run1/gone.md', path.join(scratch, 'gone.md')),
      error => error.code === 'ENOENT'
    );
    sealedFiles.configureSealedFiles({ enabled: true, keyProvider: keys });
  });
});
