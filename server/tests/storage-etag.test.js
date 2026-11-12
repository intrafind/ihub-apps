// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The document etag rule on its own, without a provider in the way.
 *
 * `storage/etag.js` is shared by both filesystem stores and is what the next
 * provider will import rather than reimplement, and the conformance suite
 * builds its expected values on the same serializer. That last part is why
 * these tests exist: a suite that expects what the implementation produces
 * cannot fail when the implementation is wrong, so the serializer needs
 * checking against something other than itself. Here that is `JSON.stringify`,
 * which it must agree with in every respect except key order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson } from '../storage/canonicalJson.js';
import { documentDigest, documentEtag, serializeDocument } from '../storage/etag.js';

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

test('object keys are sorted, at every depth', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson({ b: { d: 1, c: 2 }, a: 3 }),
    '{"a":3,"b":{"c":2,"d":1}}',
    'nested objects too, or a reordered sub-object still changes the etag'
  );
  assert.equal(
    canonicalJson({ b: 1, a: 2 }),
    canonicalJson({ a: 2, b: 1 }),
    'which is the whole point: key order is not part of the document'
  );
});

test('array order is preserved, and objects inside arrays are still sorted', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]', 'array order is data');
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.notEqual(
    canonicalJson({ xs: [1, 2] }),
    canonicalJson({ xs: [2, 1] }),
    'so swapping two elements is a different document'
  );
});

test('it agrees with JSON.stringify in every respect but key order', () => {
  // Checked against the platform's own serializer rather than against a
  // hand-written expectation: escaping, `toJSON` and the treatment of
  // `undefined` are exactly the behaviours nobody wants to reimplement.
  for (const data of [
    null,
    0,
    '',
    'plain',
    { a: 1, b: [1, 2], c: null },
    { a: 'quote " backslash \\ newline \n tab \t' },
    { a: 'unicode: äöü 😀   ' },
    { a: { b: { c: { d: [1, { e: 2 }] } } } },
    [],
    {},
    { a: new Date(0).toISOString() }
  ]) {
    assert.equal(canonicalJson(data), JSON.stringify(data), JSON.stringify(data));
  }
});

test('toJSON is honoured, so a Date serializes as it always did', () => {
  const data = { when: new Date(0) };
  assert.equal(canonicalJson(data), JSON.stringify(data));
  assert.equal(canonicalJson(data), '{"when":"1970-01-01T00:00:00.000Z"}');
});

test('undefined values and functions are dropped, exactly as JSON.stringify drops them', () => {
  const data = { a: undefined, b: 1, c: () => {} };
  assert.equal(canonicalJson(data), JSON.stringify(data));
  assert.equal(canonicalJson(data), '{"b":1}');
});

test('sorting cannot change the byte length, so size is order-invariant', () => {
  const one = serializeDocument({ title: 'x', id: 'c1' });
  const other = serializeDocument({ id: 'c1', title: 'x' });
  assert.equal(Buffer.byteLength(one, 'utf8'), Buffer.byteLength(other, 'utf8'));
  assert.equal(one, other);
});

test('documentEtag is a stable sha256 hex of what it is given', () => {
  assert.equal(documentEtag('abc'), sha256('abc'));
  assert.match(documentEtag('abc'), /^[0-9a-f]{64}$/);
  assert.equal(documentEtag('abc'), documentEtag('abc'), 'stable across calls');
  assert.notEqual(documentEtag('abc'), documentEtag('abd'));
});

test('the two document shapes reach the same digest by different routes', () => {
  // Enveloped namespaces digest the canonical serialization; raw namespaces
  // digest the file's bytes, because there the file is the document. The rule
  // is one function either way — only the input differs.
  const data = { b: 1, a: 2 };
  const enveloped = documentEtag(serializeDocument(data));
  const rawBytes = JSON.stringify(data, null, 2);
  const raw = documentEtag(rawBytes);

  assert.equal(enveloped, sha256('{"a":2,"b":1}'));
  assert.equal(raw, sha256(rawBytes));
  assert.notEqual(
    enveloped,
    raw,
    'and they differ, which is what lets a raw compare-and-set notice a hand edit'
  );
});

test('documentDigest reports the etag and size of the canonical serialization', () => {
  // The digest is taken without building the canonical string (or the
  // key-sorted copy of every object `canonicalJson` builds on the way), so it
  // is checked against that serialization rather than against itself.
  const nested = { z: [3, { y: 'ü', x: null }], a: { d: 1.5, c: -0, b: [[], {}] } };
  const parsed = JSON.parse('{"__proto__":{"x":1},"b":"\\ud800 lone","a":"\\u2028"}');
  for (const data of [
    null,
    0,
    -0,
    1e21,
    Number.NaN,
    Infinity,
    true,
    '',
    'quote " backslash \\ newline \n tab \t \u0001',
    'unicode: äöü 😀 \ud83d',
    [],
    {},
    [undefined, () => {}, Symbol('s'), 1],
    { a: undefined, b: 1, c: () => {} },
    { when: new Date(0), nested: { toJSON: () => ({ b: 1, a: 2 }) } },
    nested,
    parsed,
    { 'key "quoted"': 1, 'b\nkey': 2, ä: 3, A: 4, 10: 5, 9: 6 },
    { 4294967294: 1, 4294967295: 2, '01': 3, 2: 4, '-1': 5, 1.5: 6 },
    { list: Array.from({ length: 5000 }, (_, i) => ({ i, s: 'x'.repeat(i % 50), t: i % 2 === 0 })) }
  ]) {
    const json = serializeDocument(data);
    assert.deepEqual(
      documentDigest(data),
      { etag: documentEtag(json), size: Buffer.byteLength(json, 'utf8') },
      String(json).slice(0, 60)
    );
  }
});

test('documentDigest agrees with the serializer on random JSON', () => {
  let seed = 3624;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const keyPool = ['a', 'B', '_', 'ä', '10', '9', '0', '007', 'é', 'z z', '"', '\\', '😀'];
  const make = depth => {
    const pick = random();
    if (depth > 3 || pick < 0.3) {
      const leaf = random();
      if (leaf < 0.2) return null;
      if (leaf < 0.4) return random() < 0.5;
      if (leaf < 0.7) return Math.round((random() - 0.5) * 1e6) / 100;
      return keyPool[Math.floor(random() * keyPool.length)].repeat(1 + Math.floor(random() * 3));
    }
    if (pick < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => make(depth + 1));
    const object = {};
    for (let i = Math.floor(random() * 5); i > 0; i -= 1) {
      object[keyPool[Math.floor(random() * keyPool.length)]] = make(depth + 1);
    }
    return object;
  };
  for (let i = 0; i < 500; i += 1) {
    // Round-tripped, as every stored body is.
    const data = JSON.parse(JSON.stringify(make(0)));
    const json = serializeDocument(data);
    assert.deepEqual(
      documentDigest(data),
      { etag: documentEtag(json), size: Buffer.byteLength(json, 'utf8') },
      json
    );
  }
});

test('documentDigest never serializes an object in one piece', () => {
  // The point of the streaming digest: a metadata-only listing of a document
  // carrying megabytes of state must not materialize a second, sorted copy of
  // it. JSON.stringify may still be used for one primitive at a time.
  const original = JSON.stringify;
  const objectCalls = [];
  JSON.stringify = function (value, ...rest) {
    if (value !== null && typeof value === 'object') objectCalls.push(value);
    return original.call(this, value, ...rest);
  };
  try {
    documentDigest({ b: { c: [1, 2, { d: 'x' }] }, a: 'y' });
  } finally {
    JSON.stringify = original;
  }
  assert.deepEqual(objectCalls, []);
});
