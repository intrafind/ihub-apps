// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A metadata-only listing on the filesystem document store (#3624).
 *
 * `list({ includeData: false })` still owes every document its `etag` and
 * `size` — both derived from the canonical serialization of the body — but
 * it must not build that serialization (or the key-sorted copy of every object
 * `canonicalJson` makes on the way) just to hash it: on a workflow state of
 * tens of megabytes that was the larger half of the boot spike.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDocuments } from './helpers/testStorage.js';

const store = await scratchDocuments({ prefix: 'ihub-test-metadata-list-' });
after(() => store.stop());

/**
 * Run `fn` while recording every `JSON.stringify` call on an object.
 *
 * @param {() => Promise<unknown>} fn - Code under observation.
 * @returns {Promise<{result: unknown, objectCalls: number}>}
 */
async function countObjectStringify(fn) {
  const original = JSON.stringify;
  let objectCalls = 0;
  JSON.stringify = function (value, ...rest) {
    if (value !== null && typeof value === 'object') objectCalls += 1;
    return original.call(this, value, ...rest);
  };
  try {
    return { result: await fn(), objectCalls };
  } finally {
    JSON.stringify = original;
  }
}

test('a metadata-only list reports the etag and size get() reports', async () => {
  await store.reset();
  const body = {
    status: 'completed',
    history: Array.from({ length: 200 }, (_, i) => ({ z: i, a: `entry ${i}`, m: { y: 1, b: 2 } }))
  };
  const written = await store.documents.put('meta-ns', 'doc-1', body, { ownerId: 'u1' });
  const page = await store.documents.list('meta-ns', { includeData: false });
  const fetched = await store.documents.get('meta-ns', 'doc-1');

  assert.equal(page.items.length, 1);
  const [item] = page.items;
  assert.equal('data' in item, false, 'no body on a metadata-only page');
  assert.equal(item.etag, written.etag);
  assert.equal(item.etag, fetched.etag);
  assert.equal(item.size, fetched.size);
  assert.equal(item.ownerId, 'u1');
  assert.equal(item.updatedAt, fetched.updatedAt);
});

test('a metadata-only list does not serialize document bodies whole', async () => {
  await store.reset();
  for (let i = 0; i < 5; i += 1) {
    await store.documents.put('meta-ns', `doc-${i}`, {
      b: { nested: [1, 2, { c: 'x'.repeat(1000) }] },
      a: Array.from({ length: 100 }, (_, j) => ({ j }))
    });
  }
  const { result, objectCalls } = await countObjectStringify(() =>
    store.documents.list('meta-ns', { includeData: false })
  );
  assert.equal(result.items.length, 5);
  assert.equal(objectCalls, 0, 'no canonical copy of a body was built to hash it');
});

test('a scan without data does not serialize document bodies whole either', async () => {
  await store.reset();
  await store.documents.put('meta-ns', 'doc-a', { b: [{ c: 1 }], a: { d: 2 } });
  const { result, objectCalls } = await countObjectStringify(async () => {
    const items = [];
    for await (const doc of store.documents.scan('meta-ns', { includeData: false })) {
      items.push(doc);
    }
    return items;
  });
  assert.equal(result.length, 1);
  assert.match(result[0].etag, /^[0-9a-f]{64}$/);
  assert.equal(objectCalls, 0);
});
