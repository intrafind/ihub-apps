// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The document seal `ihub-doc-v1` (`crypto/documentSeal.js`): the recorded
 * format vectors still open, the associated data is the recorded string, and
 * a document opens only where it was sealed: same tenant, namespace, key,
 * owner and content type.
 */
import './support/scratchContents.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-doc-seal-'));
const keyModule = await import('../crypto/KeyProvider.js');
const {
  DOCUMENT_SEAL_FORMAT,
  DocumentSealError,
  documentAssociatedData,
  documentEtagAssociatedData,
  isSealedHead,
  openDocument,
  openDocumentEtag,
  sealDocument
} = await import('../crypto/documentSeal.js');
const { fixedKeys, MASTER_KEY_A, MASTER_KEY_B } = await import('./support/blobTestSupport.js');

const vectors = JSON.parse(
  fs.readFileSync(new URL('./fixtures/document-seal/vectors.json', import.meta.url), 'utf8')
);
const keyProvider = fixedKeys(keyModule, { master: MASTER_KEY_A }).provider;
const ETAG = 'ab'.repeat(32);
const ADDRESS = {
  tenant: 'default',
  ns: 'chats',
  key: 'chat-1',
  ownerId: 'anna@example.org',
  contentType: 'application/json'
};

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('document seal: recorded format vectors', () => {
  it('uses the master key the vectors were recorded with', () => {
    assert.equal(vectors.format, DOCUMENT_SEAL_FORMAT);
    assert.equal(vectors.masterKey, MASTER_KEY_A);
    assert.ok(vectors.documents.length >= 4);
  });

  for (const vector of vectors.documents) {
    it(`opens ${vector.address.ns}/${vector.address.key} as recorded`, async () => {
      assert.equal(documentAssociatedData(vector.address), vector.bodyAssociatedData);
      assert.equal(documentEtagAssociatedData(vector.address), vector.etagAssociatedData);
      assert.equal(isSealedHead(vector.sealed), true);
      const opened = await openDocument({
        keyProvider,
        address: vector.address,
        envelope: vector.sealed
      });
      assert.deepEqual(opened, { json: vector.json, etag: vector.etag });
      const { data: _data, ...head } = vector.sealed;
      assert.equal(
        await openDocumentEtag({ keyProvider, address: vector.address, head }),
        vector.etag
      );
    });
  }

  it('builds the associated data as a JSON array with the segment size', () => {
    assert.equal(
      documentAssociatedData(ADDRESS),
      '["ihub/doc/v1","default","chats","chat-1","anna@example.org","application/json",1048576]'
    );
    assert.equal(
      documentEtagAssociatedData({ ...ADDRESS, ownerId: null }),
      '["ihub/doc-etag/v1","default","chats","chat-1",null,"application/json",1048576]'
    );
  });
});

describe('document seal: sealing and opening', () => {
  it('round-trips a body and its etag, with a fresh key and ciphertext per write', async () => {
    const json = JSON.stringify({ title: 'Quarterly numbers', n: [1, 2, 3] });
    const first = await sealDocument({ keyProvider, address: ADDRESS, json, etag: ETAG });
    const second = await sealDocument({ keyProvider, address: ADDRESS, json, etag: ETAG });
    assert.deepEqual(Object.keys(first), ['enc', 'kp', 'kid', 'wk', 'tag', 'data']);
    assert.equal(first.enc, 'ihub-doc-v1');
    assert.equal(first.kp, 'local-file');
    assert.notEqual(first.wk, second.wk);
    assert.notEqual(first.data, second.data);
    assert.notEqual(first.tag, second.tag);
    assert.deepEqual(await openDocument({ keyProvider, address: ADDRESS, envelope: first }), {
      json,
      etag: ETAG
    });
  });

  it('stores neither the body nor the etag in a readable form', async () => {
    const json = JSON.stringify({ title: 'MARKER-TITLE' });
    const sealed = JSON.stringify(
      await sealDocument({ keyProvider, address: ADDRESS, json, etag: ETAG })
    );
    for (const needle of ['MARKER-TITLE', ETAG, Buffer.from('MARKER-TITLE').toString('base64')]) {
      assert.equal(sealed.includes(needle), false, needle);
    }
  });

  it('seals a 3 MiB body over several segments', async () => {
    const json = JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) });
    const sealed = await sealDocument({ keyProvider, address: ADDRESS, json, etag: ETAG });
    const opened = await openDocument({ keyProvider, address: ADDRESS, envelope: sealed });
    assert.equal(opened.json, json);
  });

  it('refuses an address or an etag that is not usable', async () => {
    const seal = overrides =>
      sealDocument({ keyProvider, address: ADDRESS, json: '{}', etag: ETAG, ...overrides });
    await assert.rejects(seal({ address: { ...ADDRESS, ns: '' } }), { code: 'BAD_ADDRESS' });
    await assert.rejects(seal({ address: { ...ADDRESS, ownerId: '' } }), { code: 'BAD_ADDRESS' });
    await assert.rejects(seal({ address: { ...ADDRESS, contentType: undefined } }), {
      code: 'BAD_ADDRESS'
    });
    await assert.rejects(seal({ etag: 'not-an-etag' }), { code: 'MALFORMED' });
    await assert.rejects(seal({ json: { not: 'text' } }), { code: 'MALFORMED' });
  });
});

describe('document seal: what does not open', () => {
  const json = JSON.stringify({ title: 'private' });
  const seal = () => sealDocument({ keyProvider, address: ADDRESS, json, etag: ETAG });
  const head = sealed => {
    const { data: _data, ...rest } = sealed;
    return rest;
  };

  for (const [name, change] of [
    ['another namespace', { ns: 'chat-shares' }],
    ['another key', { key: 'chat-2' }],
    ['another owner', { ownerId: 'bert@example.org' }],
    ['no owner', { ownerId: null }],
    ['another content type', { contentType: 'text/plain' }],
    ['another tenant', { tenant: 'other' }]
  ]) {
    it(`a document read at ${name}`, async () => {
      const sealed = await seal();
      const address = { ...ADDRESS, ...change };
      // The key wrap is bound to the address as well: the provider refuses.
      await assert.rejects(openDocument({ keyProvider, address, envelope: sealed }), {
        name: 'KeyAccessDenied',
        reason: 'unwrap-failed'
      });
      await assert.rejects(openDocumentEtag({ keyProvider, address, head: head(sealed) }), {
        name: 'KeyAccessDenied'
      });
    });
  }

  it('a changed byte in the body, the tag or the wrapped key', async () => {
    const flip = base64 => {
      const bytes = Buffer.from(base64, 'base64');
      bytes[bytes.length - 3] ^= 0x01;
      return bytes.toString('base64');
    };
    const sealed = await seal();
    const open = envelope => openDocument({ keyProvider, address: ADDRESS, envelope });
    await assert.rejects(open({ ...sealed, data: flip(sealed.data) }), { code: 'VERIFY_FAILED' });
    await assert.rejects(open({ ...sealed, tag: flip(sealed.tag) }), { code: 'VERIFY_FAILED' });
    await assert.rejects(open({ ...sealed, wk: flip(sealed.wk) }), { name: 'KeyAccessDenied' });
  });

  it('a body and a tag that were swapped, or taken from another write', async () => {
    const [one, two] = [await seal(), await seal()];
    const open = envelope => openDocument({ keyProvider, address: ADDRESS, envelope });
    await assert.rejects(open({ ...one, data: one.tag, tag: one.data }), DocumentSealError);
    await assert.rejects(open({ ...one, data: two.data }), { code: 'VERIFY_FAILED' });
    await assert.rejects(open({ ...one, tag: two.tag }), { code: 'VERIFY_FAILED' });
  });

  it('a document sealed with another master key or key provider', async () => {
    const sealed = await seal();
    const other = fixedKeys(keyModule, { master: MASTER_KEY_B }).provider;
    await assert.rejects(openDocument({ keyProvider: other, address: ADDRESS, envelope: sealed }), {
      name: 'KeyAccessDenied',
      reason: 'unknown-key'
    });
    await assert.rejects(
      openDocument({ keyProvider, address: ADDRESS, envelope: { ...sealed, kp: 'transit' } }),
      { code: 'KEY_PROVIDER_MISMATCH', keyProviderId: 'transit' }
    );
  });

  it('a sealed head with a missing or malformed member', async () => {
    const sealed = await seal();
    for (const member of ['enc', 'kp', 'kid', 'wk', 'tag']) {
      const { [member]: _dropped, ...rest } = sealed;
      assert.equal(isSealedHead(rest), false, member);
      await assert.rejects(openDocument({ keyProvider, address: ADDRESS, envelope: rest }), {
        code: 'MALFORMED'
      });
    }
    assert.equal(isSealedHead({ ...sealed, enc: 'ihub-doc-v2' }), false);
    await assert.rejects(
      openDocument({
        keyProvider,
        address: ADDRESS,
        envelope: { ...sealed, data: { title: 'x' } }
      }),
      { code: 'MALFORMED' }
    );
  });
});
