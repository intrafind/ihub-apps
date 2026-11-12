// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Metadata-only reads on the filesystem document store (#3624).
 *
 * Every envelope carries the `etag` and `size` `put` computed, before `data`,
 * so a metadata-only listing (`listMetadata`, `list({ includeData: false })`,
 * `scan({ includeData: false })`) takes them from the start of the file and
 * never parses, canonicalizes or hashes a body. On a workflow state of tens of
 * megabytes that was the whole boot spike.
 *
 * Migration V249 upgrades the stored envelopes once. One that turns up later
 * without `etag` and `size` (a backup restored, a rollback that kept writing)
 * is served by every read and written back upgraded, once; an etag that is
 * present but malformed is still a corrupt document.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scratchDocuments } from './helpers/testStorage.js';
import { documentDigest } from '../storage/etag.js';
import { CorruptDocumentError } from '../storage/errors.js';

const store = await scratchDocuments({ prefix: 'ihub-test-metadata-list-' });
after(() => store.stop());

const BIG = 200_000;

/**
 * Run `fn` while recording the size of every string `JSON.parse` is handed and
 * every object `JSON.stringify` is handed.
 *
 * @param {() => Promise<unknown>} fn - Code under observation.
 * @returns {Promise<{result: unknown, largestParse: number, objectStringify: number}>}
 */
async function observeJson(fn) {
  const { parse, stringify } = JSON;
  let largestParse = 0;
  let objectStringify = 0;
  JSON.parse = function (text, ...rest) {
    largestParse = Math.max(largestParse, String(text).length);
    return parse.call(this, text, ...rest);
  };
  JSON.stringify = function (value, ...rest) {
    if (value !== null && typeof value === 'object') objectStringify += 1;
    return stringify.call(this, value, ...rest);
  };
  try {
    return { result: await fn(), largestParse, objectStringify };
  } finally {
    JSON.parse = parse;
    JSON.stringify = stringify;
  }
}

function bigBody(i = 0) {
  return {
    status: 'completed',
    history: Array.from({ length: 2000 }, (_, j) => ({ z: j, a: `entry ${i}/${j} `.repeat(8) }))
  };
}

/** Envelope file of a document; the scratch provider's base directory is `<dir>/data`. */
const envelopePath = (ns, key) => path.join(store.dir, 'data', ns, `${key}.json`);

test('the stored envelope carries etag and size before the body', async () => {
  await store.reset();
  const written = await store.documents.put('meta-ns', 'doc-1', bigBody(), { ownerId: 'u1' });
  const raw = await fs.readFile(envelopePath('meta-ns', 'doc-1'), 'utf8');
  const envelope = JSON.parse(raw);
  assert.equal(envelope.v, 2);
  assert.equal(envelope.etag, written.etag);
  assert.equal(envelope.size, written.size);
  assert.deepEqual({ etag: written.etag, size: written.size }, documentDigest(bigBody()));
  assert.ok(raw.indexOf('"etag"') < raw.indexOf('"data"'), 'etag precedes data');
  assert.ok(raw.indexOf('"size"') < raw.indexOf('"data"'), 'size precedes data');
});

test('metadata-only reads report what get() reports, and never parse a body', async () => {
  await store.reset();
  for (let i = 0; i < 5; i += 1) {
    await store.documents.put('meta-ns', `doc-${i}`, bigBody(i), { ownerId: 'u1' });
  }
  const fetched = await store.documents.get('meta-ns', 'doc-3');
  assert.ok(fetched.size > BIG, 'the fixture is large');

  for (const [label, read] of [
    ['listMetadata', () => store.documents.listMetadata('meta-ns')],
    ['list without data', () => store.documents.list('meta-ns', { includeData: false })],
    [
      'list by owner without data',
      () => store.documents.list('meta-ns', { includeData: false, ownerId: 'u1' })
    ],
    [
      'scan without data',
      async () => {
        const items = [];
        for await (const doc of store.documents.scan('meta-ns', { includeData: false })) {
          items.push(doc);
        }
        return { items };
      }
    ]
  ]) {
    const { result, largestParse, objectStringify } = await observeJson(read);
    assert.equal(result.items.length, 5, label);
    assert.ok(largestParse < 10_000, `${label}: largest JSON.parse input was ${largestParse}`);
    assert.equal(objectStringify, 0, `${label}: no body serialized`);
    const item = result.items.find(doc => doc.key === 'doc-3');
    assert.equal('data' in item, false, label);
    for (const field of [
      'ns',
      'key',
      'ownerId',
      'contentType',
      'createdAt',
      'updatedAt',
      'etag',
      'size'
    ]) {
      assert.deepEqual(item[field], fetched[field], `${label}: ${field}`);
    }
  }
});

test('listMetadata pages like list', async () => {
  await store.reset();
  for (const key of ['a', 'b', 'c']) await store.documents.put('meta-ns', key, { key });
  const first = await store.documents.listMetadata('meta-ns', { limit: 2 });
  assert.deepEqual(
    first.items.map(item => item.key),
    ['a', 'b']
  );
  const second = await store.documents.listMetadata('meta-ns', {
    limit: 2,
    cursor: first.nextCursor
  });
  assert.deepEqual(
    second.items.map(item => item.key),
    ['c']
  );
  assert.equal(second.nextCursor, null);
});

const legacyEnvelope = (key, data, stamp) => ({
  v: 1,
  key,
  ownerId: 'u1',
  contentType: 'application/json',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: stamp,
  data
});

/** Write an envelope the way releases before V249 did: no etag, no size. */
async function writeLegacy(key, data, stamp = '2026-01-02T00:00:00.000Z') {
  const dir = path.join(store.dir, 'data', 'meta-ns');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${key}.json`),
    JSON.stringify(legacyEnvelope(key, data, stamp), null, 2)
  );
}

async function readRaw(key) {
  return JSON.parse(await fs.readFile(envelopePath('meta-ns', key), 'utf8'));
}

test('an envelope stored without etag and size is served by every read and upgraded once', async () => {
  // E.g. restored from a backup taken before the upgrade, after V249 ran.
  for (const [label, read] of [
    ['get', key => store.documents.get('meta-ns', key)],
    ['list', async key => (await store.documents.list('meta-ns')).items.find(d => d.key === key)],
    [
      'list without data',
      async key =>
        (await store.documents.list('meta-ns', { includeData: false })).items.find(
          d => d.key === key
        )
    ],
    [
      'listMetadata',
      async key => (await store.documents.listMetadata('meta-ns')).items.find(d => d.key === key)
    ],
    [
      'scan without data',
      async key => {
        for await (const doc of store.documents.scan('meta-ns', { includeData: false })) {
          if (doc.key === key) return doc;
        }
        return null;
      }
    ]
  ]) {
    await store.reset();
    const data = { b: [1, { z: 'ä' }], a: 'body' };
    await writeLegacy('old', data);
    const before = await readRaw('old');

    const doc = await read('old');
    assert.ok(doc, `${label}: the document is returned`);
    assert.deepEqual({ etag: doc.etag, size: doc.size }, documentDigest(data), label);
    assert.equal(doc.updatedAt, before.updatedAt, label);

    // Written back: same body, owner and timestamps, now with the digest.
    const after = await readRaw('old');
    assert.equal(after.v, 2, label);
    assert.equal(after.etag, doc.etag, label);
    assert.equal(after.size, doc.size, label);
    assert.deepEqual(after.data, data, label);
    assert.equal(after.ownerId, 'u1', label);
    assert.equal(after.createdAt, before.createdAt, label);
    assert.equal(after.updatedAt, before.updatedAt, `${label}: not an edit`);

    // Later metadata reads take the cheap path again.
    const { result, largestParse } = await observeJson(() =>
      store.documents.listMetadata('meta-ns')
    );
    assert.equal(result.items[0].etag, doc.etag, label);
    assert.equal(result.skipped, undefined, label);
    assert.ok(largestParse < 1000, `${label}: ${largestParse}`);
  }
});

test('the upgrade publishes no change event', async () => {
  await store.reset();
  const events = [];
  const notifier = store.provider.notifier;
  const unsubscribe = notifier.subscribe(event => events.push(event));
  try {
    await writeLegacy('quiet', { a: 1 });
    await store.documents.get('meta-ns', 'quiet');
    assert.equal((await readRaw('quiet')).v, 2);
    assert.deepEqual(
      events.filter(event => event.key === 'quiet'),
      []
    );
  } finally {
    unsubscribe?.();
  }
});

test('a compare-and-set works on an envelope stored without etag', async () => {
  await store.reset();
  await writeLegacy('cas', { a: 1 });
  const written = await store.documents.put(
    'meta-ns',
    'cas',
    { a: 2 },
    {
      etag: documentDigest({ a: 1 }).etag
    }
  );
  assert.equal(written.createdAt, '2026-01-01T00:00:00.000Z', 'createdAt is carried over');
  assert.equal(written.ownerId, 'u1');
});

test('the write-back never overwrites a newer write', async () => {
  await store.reset();
  await writeLegacy('raced', { a: 1 }, '2026-01-02T00:00:00.000Z');
  // What a read saw, before anything was written back...
  const stale = await store.provider._envelopeDocuments._readEnvelope('meta-ns', 'raced');
  // ...then a newer write lands — in the old format, by an older release...
  await writeLegacy('raced', { a: 'newer' }, '2026-01-03T00:00:00.000Z');
  assert.equal(
    await store.provider._envelopeDocuments._upgradeLegacyEnvelope('meta-ns', 'raced', stale),
    false
  );
  assert.deepEqual((await readRaw('raced')).data, { a: 'newer' });
  // ...or by this release.
  await store.documents.put('meta-ns', 'raced', { a: 'newest' });
  assert.equal(
    await store.provider._envelopeDocuments._upgradeLegacyEnvelope('meta-ns', 'raced', stale),
    false
  );
  assert.deepEqual((await readRaw('raced')).data, { a: 'newest' });
});

test('an envelope with a malformed etag stays a corrupt document', async () => {
  await store.reset();
  await store.documents.put('meta-ns', 'good', { ok: true });
  const dir = path.join(store.dir, 'data', 'meta-ns');
  const now = new Date().toISOString();
  const tampered = {
    v: 2,
    key: 'tampered',
    ownerId: null,
    contentType: 'application/json',
    createdAt: now,
    updatedAt: now,
    data: { a: 1 }
  };
  await fs.writeFile(
    path.join(dir, 'tampered.json'),
    JSON.stringify({ ...tampered, etag: 'nope', size: 7 }, null, 2)
  );
  await fs.writeFile(
    path.join(dir, 'half.json'),
    JSON.stringify({ ...tampered, key: 'half', size: 7 }, null, 2)
  );

  for (const options of [{ includeData: false }, {}]) {
    const page = await store.documents.list('meta-ns', options);
    assert.deepEqual(
      page.items.map(item => item.key),
      ['good'],
      JSON.stringify(options)
    );
    assert.equal(page.skipped, 2, JSON.stringify(options));
  }
  await assert.rejects(store.documents.get('meta-ns', 'tampered'), CorruptDocumentError);
  await assert.rejects(store.documents.get('meta-ns', 'half'), CorruptDocumentError);

  // An unconditional overwrite is still the repair, as for any torn document.
  const repaired = await store.documents.put('meta-ns', 'tampered', { a: 1 });
  assert.deepEqual({ etag: repaired.etag, size: repaired.size }, documentDigest({ a: 1 }));
});
