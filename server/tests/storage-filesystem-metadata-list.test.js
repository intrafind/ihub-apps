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
 * There is no fallback for an envelope without them: migration V247 upgrades
 * the stored ones once, and anything left without a valid etag is reported
 * like any other corrupt document instead of being silently recomputed.
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

test('an envelope without a valid etag is a corrupt document, not recomputed', async () => {
  await store.reset();
  await store.documents.put('meta-ns', 'good', { ok: true });
  const dir = path.join(store.dir, 'data', 'meta-ns');
  const now = new Date().toISOString();
  // What releases before V247 wrote: no etag, no size.
  await fs.writeFile(
    path.join(dir, 'legacy.json'),
    JSON.stringify(
      {
        v: 1,
        key: 'legacy',
        ownerId: null,
        contentType: 'application/json',
        createdAt: now,
        updatedAt: now,
        data: { a: 1 }
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(dir, 'tampered.json'),
    JSON.stringify(
      {
        v: 2,
        key: 'tampered',
        ownerId: null,
        contentType: 'application/json',
        createdAt: now,
        updatedAt: now,
        etag: 'nope',
        size: 7,
        data: { a: 1 }
      },
      null,
      2
    )
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
  await assert.rejects(store.documents.get('meta-ns', 'legacy'), CorruptDocumentError);
  await assert.rejects(store.documents.get('meta-ns', 'tampered'), CorruptDocumentError);

  // An unconditional overwrite is still the repair, as for any torn document.
  const repaired = await store.documents.put('meta-ns', 'legacy', { a: 1 });
  assert.deepEqual({ etag: repaired.etag, size: repaired.size }, documentDigest({ a: 1 }));
});
