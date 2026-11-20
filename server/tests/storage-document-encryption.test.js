// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sealed documents on the filesystem provider (envelope version 3):
 * what is on disk, the three modes, mixed state, and what a writer of the
 * data directory can and cannot do.
 */
import './support/scratchContents.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CorruptDocumentError, PlaintextDocumentError } from '../storage/errors.js';
import { documentDigest } from '../storage/etag.js';
import { MASTER_KEY_B } from './support/blobTestSupport.js';
import { findReadable, providerInMode, testKeys } from './support/atRestTestSupport.js';

const NS = 'chats';
const ANNA = 'anna@example.org';
const BERT = 'bert@example.org';
const BODY = { title: 'MARKER-TITLE budget review', settings: { model: 'm1' } };

let baseDir;
let open = [];

/** Open a provider in a mode over the shared directory. */
async function start(mode, options) {
  const provider = providerInMode(baseDir, mode, options);
  await provider.initialize();
  open.push(provider);
  return provider;
}

const docFile = (key, ns = NS) => path.join(baseDir, ns, `${key}.json`);
const readStored = async (key, ns) => JSON.parse(await fs.readFile(docFile(key, ns), 'utf8'));
const writeStored = (key, envelope, ns) =>
  fs.writeFile(docFile(key, ns), JSON.stringify(envelope, null, 2));

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-doc-enc-'));
  open = [];
});

afterEach(async () => {
  for (const provider of open) await provider.shutdown();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('sealed documents: what is on disk', () => {
  it('writes envelope version 3 with the head readable and the body, title and etag sealed', async () => {
    const { documents } = await start('enforced');
    const written = await documents.put(NS, 'c1', BODY, { ownerId: ANNA });
    assert.equal(written.etag, documentDigest(BODY).etag, 'the etag is the plaintext etag');

    const stored = await readStored('c1');
    assert.deepEqual(Object.keys(stored), [
      'v',
      'key',
      'ownerId',
      'contentType',
      'createdAt',
      'updatedAt',
      'size',
      'enc',
      'kp',
      'kid',
      'wk',
      'tag',
      'data'
    ]);
    assert.equal(stored.v, 3);
    assert.equal(stored.enc, 'ihub-doc-v1');
    assert.equal(stored.ownerId, ANNA);
    assert.equal(stored.size, written.size);
    assert.equal(typeof stored.data, 'string');
    assert.equal('etag' in stored, false, 'no plaintext hash beside the ciphertext');
    assert.deepEqual(await findReadable(baseDir, ['MARKER-TITLE', written.etag]), []);
  });

  it('reports the same document, etag and size in every mode', async () => {
    const plain = await (await start('off')).documents.put(NS, 'c1', BODY, { ownerId: ANNA });
    await fs.rm(docFile('c1'));
    const sealed = await (await start('enforced')).documents.put(NS, 'c1', BODY, { ownerId: ANNA });
    for (const field of ['etag', 'size', 'ownerId', 'contentType', 'key', 'ns']) {
      assert.equal(sealed[field], plain[field], field);
    }
    assert.deepEqual(sealed.data, plain.data);
  });

  it("keeps the writer's key order in the body", async () => {
    const { documents } = await start('enforced');
    await documents.put(NS, 'c1', { z: 1, a: 2, m: { y: 1, b: 2 } });
    assert.equal(
      JSON.stringify((await documents.get(NS, 'c1')).data),
      '{"z":1,"a":2,"m":{"y":1,"b":2}}'
    );
  });

  it('leaves the raw configuration namespaces as plain files', async () => {
    const provider = await start('enforced');
    await provider.documents.put('apps', 'my-app', { id: 'my-app', name: { en: 'MARKER-APP' } });
    const raw = await fs.readFile(path.join(provider.contentsDir, 'apps', 'my-app.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), { id: 'my-app', name: { en: 'MARKER-APP' } });
  });
});

describe('sealed documents: reads, listings and conditional writes', () => {
  it('serves get, list, metadata listings and scan with the plaintext etag', async () => {
    const { documents } = await start('enforced');
    const one = await documents.put(NS, 'c1', BODY, { ownerId: ANNA });
    const two = await documents.put(NS, 'c2', { title: 'two' }, { ownerId: ANNA });
    await documents.put(NS, 'c3', { title: 'three' }, { ownerId: BERT });

    assert.deepEqual((await documents.get(NS, 'c1')).data, BODY);
    const listed = await documents.list(NS, { ownerId: ANNA });
    assert.deepEqual(
      listed.items.map(item => [item.key, item.etag]),
      [
        ['c1', one.etag],
        ['c2', two.etag]
      ]
    );
    const heads = await documents.list(NS, { includeData: false });
    assert.deepEqual(heads.items.map(item => item.etag).slice(0, 2), [one.etag, two.etag]);
    assert.equal('data' in heads.items[0], false);
    const scanned = [];
    for await (const item of documents.scan(NS, { ownerId: BERT })) scanned.push(item.data.title);
    assert.deepEqual(scanned, ['three']);
  });

  it('compares and sets on the sealed etag, and keeps owner and createdAt', async () => {
    const { documents } = await start('enforced');
    const first = await documents.put(NS, 'c1', BODY, { ownerId: ANNA });
    await assert.rejects(documents.put(NS, 'c1', { title: 'x' }, { etag: 'f'.repeat(64) }), {
      code: 'ETAG_MISMATCH'
    });
    const second = await documents.put(NS, 'c1', { title: 'renamed' }, { etag: first.etag });
    assert.equal(second.ownerId, ANNA);
    assert.equal(second.createdAt, first.createdAt);
    await assert.rejects(documents.put(NS, 'c1', { title: 'stale' }, { etag: first.etag }), {
      code: 'ETAG_MISMATCH'
    });
    await assert.rejects(documents.put(NS, 'c1', {}, { etag: null }), { code: 'ETAG_MISMATCH' });
    const moved = await documents.put(NS, 'c1', { title: 'moved' }, { ownerId: BERT });
    assert.equal(moved.ownerId, BERT);
    assert.equal((await documents.list(NS, { ownerId: ANNA })).items.length, 0);
    assert.equal(await documents.delete(NS, 'c1'), true);
    assert.equal(await documents.get(NS, 'c1'), null);
  });
});

describe('sealed documents: the three modes and mixed state', () => {
  it('reads plaintext and sealed documents side by side while converting and with the switch off', async () => {
    await (await start('off')).documents.put(NS, 'plain', BODY, { ownerId: ANNA });
    const converting = await start('converting');
    await converting.documents.put(NS, 'sealed', { title: 'sealed' }, { ownerId: ANNA });
    assert.equal((await readStored('plain')).v, 2);
    assert.equal((await readStored('sealed')).v, 3);

    for (const mode of ['converting', 'off']) {
      const { documents } = await start(mode);
      assert.deepEqual((await documents.get(NS, 'plain')).data, BODY, mode);
      assert.deepEqual((await documents.get(NS, 'sealed')).data, { title: 'sealed' }, mode);
      const listed = await documents.list(NS, { ownerId: ANNA });
      assert.deepEqual(
        listed.items.map(item => item.key),
        ['plain', 'sealed'],
        mode
      );
      assert.equal(listed.skipped, undefined, mode);
    }
  });

  it('enforced: a plaintext document is an error on get, skipped and counted by list, skipped by scan', async () => {
    await (await start('off')).documents.put(NS, 'plain', BODY, { ownerId: ANNA });
    const { documents } = await start('enforced');
    await documents.put(NS, 'sealed', { title: 'sealed' }, { ownerId: ANNA });

    await assert.rejects(documents.get(NS, 'plain'), error => {
      assert.ok(error instanceof PlaintextDocumentError);
      assert.ok(error instanceof CorruptDocumentError);
      assert.equal(error.code, 'PLAINTEXT_DOCUMENT');
      return true;
    });
    for (const includeData of [true, false]) {
      const listed = await documents.list(NS, { includeData });
      assert.deepEqual(
        listed.items.map(item => item.key),
        ['sealed']
      );
      assert.equal(listed.skipped, 1);
    }
    const scanned = [];
    for await (const item of documents.scan(NS)) scanned.push(item.key);
    assert.deepEqual(scanned, ['sealed']);
    // Never repaired by a read, and not taken as the base of a conditional write.
    assert.equal((await readStored('plain')).v, 2);
    const plainEtag = documentDigest(BODY).etag;
    await assert.rejects(documents.put(NS, 'plain', { title: 'x' }, { etag: plainEtag }), {
      code: 'ETAG_MISMATCH'
    });
    await assert.rejects(documents.put(NS, 'plain', {}, { etag: null }), { code: 'ETAG_MISMATCH' });
  });

  it('never takes a plaintext body that looks like ciphertext for a sealed document', async () => {
    const sealedLooking = {
      enc: 'ihub-doc-v1',
      kp: 'local-file',
      kid: '00000000',
      wk: 'AAAA',
      tag: 'AAAA',
      data: 'AAAA'
    };
    const { documents } = await start('off');
    await documents.put(NS, 'c1', sealedLooking);
    await documents.put(NS, 'c2', Buffer.from('just base64 text').toString('base64'));
    assert.deepEqual((await documents.get(NS, 'c1')).data, sealedLooking);
    assert.equal((await readStored('c1')).v, 2);
    const enforced = await start('enforced');
    await assert.rejects(enforced.documents.get(NS, 'c1'), { code: 'PLAINTEXT_DOCUMENT' });
    await assert.rejects(enforced.documents.get(NS, 'c2'), { code: 'PLAINTEXT_DOCUMENT' });
  });

  it('switch off after on: writes plaintext again, sealed documents stay readable and writable', async () => {
    const sealed = await (
      await start('enforced')
    ).documents.put(NS, 'old', BODY, { ownerId: ANNA });
    const { documents } = await start('off');
    assert.deepEqual((await documents.get(NS, 'old')).data, BODY);
    await documents.put(NS, 'new', { title: 'after' }, { ownerId: ANNA });
    assert.equal((await readStored('new')).v, 2);
    assert.equal((await readStored('old')).v, 3, 'nothing is converted back');
    // A compare-and-set against a sealed document still works, and rewrites it in plaintext.
    const updated = await documents.put(NS, 'old', { title: 'edited' }, { etag: sealed.etag });
    assert.equal(updated.ownerId, ANNA);
    assert.equal((await readStored('old')).v, 2);
  });

  it('with the master key gone: KEY_UNAVAILABLE, never "not found" and never a write over it', async () => {
    const sealed = await (await start('enforced')).documents.put(NS, 'c1', BODY, { ownerId: ANNA });
    for (const mode of ['off', 'enforced']) {
      const { documents } = await start(mode, { keys: testKeys({ master: null }) });
      await assert.rejects(documents.get(NS, 'c1'), { code: 'KEY_UNAVAILABLE' }, mode);
      await assert.rejects(documents.list(NS), { code: 'KEY_UNAVAILABLE' }, mode);
      await assert.rejects(documents.put(NS, 'c1', {}, { etag: sealed.etag }), {
        code: 'KEY_UNAVAILABLE'
      });
    }
    const other = await start('enforced', { keys: testKeys({ master: MASTER_KEY_B }) });
    const { kid } = await readStored('c1');
    await assert.rejects(other.documents.get(NS, 'c1'), { code: 'KEY_UNAVAILABLE', keyId: kid });
    // The previous key opens it after a key change.
    const rotated = await start('enforced', {
      keys: testKeys({ master: MASTER_KEY_B, previous: testKeys().provider._readMasterKey() })
    });
    assert.deepEqual((await rotated.documents.get(NS, 'c1')).data, BODY);
  });
});

describe('sealed documents: what a writer of the data directory cannot do', () => {
  /** Two sealed chats of two owners, and a store to read them through. */
  async function twoChats() {
    const { documents } = await start('enforced');
    await documents.put(NS, 'anna-chat', BODY, { ownerId: ANNA });
    await documents.put(NS, 'bert-chat', { title: 'bert' }, { ownerId: BERT });
    return documents;
  }
  const flip = base64 => {
    const bytes = Buffer.from(base64, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    return bytes.toString('base64');
  };

  for (const member of ['data', 'tag', 'wk']) {
    it(`a changed byte in "${member}" fails the read`, async () => {
      const documents = await twoChats();
      const stored = await readStored('anna-chat');
      await writeStored('anna-chat', { ...stored, [member]: flip(stored[member]) });
      await assert.rejects(documents.get(NS, 'anna-chat'), { code: 'CORRUPT_DOCUMENT' });
      if (member !== 'data') {
        const listed = await documents.list(NS, { includeData: false });
        assert.deepEqual(
          listed.items.map(item => item.key),
          ['bert-chat']
        );
        assert.equal(listed.skipped, 1);
      }
    });
  }

  it('an owner edited into the head hands the chat to nobody', async () => {
    const documents = await twoChats();
    const stored = await readStored('anna-chat');
    await writeStored('anna-chat', { ...stored, ownerId: BERT });
    // The marker a real change of owner would have written.
    const bertMarkers = path.dirname(
      (await fs.readdir(path.join(baseDir, NS, '.owners'), { recursive: true }))
        .map(entry => path.join(baseDir, NS, '.owners', entry))
        .find(entry => entry.endsWith('bert-chat'))
    );
    await fs.writeFile(path.join(bertMarkers, 'anna-chat'), '');

    await assert.rejects(documents.get(NS, 'anna-chat'), { code: 'CORRUPT_DOCUMENT' });
    for (const includeData of [true, false]) {
      const listed = await documents.list(NS, { ownerId: BERT, includeData });
      assert.deepEqual(
        listed.items.map(item => item.key),
        ['bert-chat']
      );
      assert.equal(listed.skipped, 1);
    }
    // And the next write that keeps the stored owner does not seal the forged one in.
    const rewritten = await documents.put(NS, 'anna-chat', { title: 'next message' });
    assert.equal(rewritten.ownerId, null);
  });

  it('a changed content type, key or sealed member in the head fails the read', async () => {
    const documents = await twoChats();
    const stored = await readStored('anna-chat');
    for (const change of [
      { contentType: 'text/html' },
      { kid: '00000000' },
      { enc: 'ihub-doc-v9' },
      { size: -1 }
    ]) {
      await writeStored('anna-chat', { ...stored, ...change });
      await assert.rejects(documents.get(NS, 'anna-chat'), error => {
        assert.match(error.code, /^(CORRUPT_DOCUMENT|KEY_UNAVAILABLE)$/, JSON.stringify(change));
        return true;
      });
    }
    await writeStored('anna-chat', stored);
    assert.deepEqual((await documents.get(NS, 'anna-chat')).data, BODY);
  });

  it('a file copied to another key or another namespace does not open there', async () => {
    const documents = await twoChats();
    await fs.copyFile(docFile('anna-chat'), docFile('bert-chat'));
    await assert.rejects(documents.get(NS, 'bert-chat'), { code: 'CORRUPT_DOCUMENT' });
    await fs.mkdir(path.join(baseDir, 'chat-shares'), { recursive: true });
    await fs.copyFile(docFile('anna-chat'), docFile('anna-chat', 'chat-shares'));
    await assert.rejects(documents.get('chat-shares', 'anna-chat'), { code: 'CORRUPT_DOCUMENT' });
    assert.deepEqual((await documents.get(NS, 'anna-chat')).data, BODY);
  });

  it('two sealed files swapped do not open', async () => {
    const documents = await twoChats();
    const [anna, bert] = [await readStored('anna-chat'), await readStored('bert-chat')];
    await writeStored('anna-chat', { ...bert, key: 'anna-chat' });
    await writeStored('bert-chat', { ...anna, key: 'bert-chat' });
    await assert.rejects(documents.get(NS, 'anna-chat'), { code: 'CORRUPT_DOCUMENT' });
    await assert.rejects(documents.get(NS, 'bert-chat'), { code: 'CORRUPT_DOCUMENT' });
  });

  it('a body replaced by plaintext JSON is not returned', async () => {
    const documents = await twoChats();
    const stored = await readStored('anna-chat');
    await writeStored('anna-chat', { ...stored, data: { title: 'planted' } });
    await assert.rejects(documents.get(NS, 'anna-chat'), { code: 'CORRUPT_DOCUMENT' });
    await writeStored('anna-chat', {
      v: 2,
      key: 'anna-chat',
      ownerId: ANNA,
      contentType: 'application/json',
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      ...documentDigest({ title: 'planted' }),
      data: { title: 'planted' }
    });
    await assert.rejects(documents.get(NS, 'anna-chat'), { code: 'PLAINTEXT_DOCUMENT' });
  });

  it('still deletes a document it cannot open, with its owner marker', async () => {
    const documents = await twoChats();
    const stored = await readStored('anna-chat');
    await writeStored('anna-chat', { ...stored, tag: flip(stored.tag) });
    assert.equal(await documents.delete(NS, 'anna-chat'), true);
    assert.deepEqual((await documents.list(NS, { ownerId: ANNA })).items, []);
  });
});
