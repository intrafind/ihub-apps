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
import { documentEtag, serializeDocument } from '../storage/etag.js';

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
