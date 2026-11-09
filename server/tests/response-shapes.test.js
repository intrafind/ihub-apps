// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffSnapshots,
  firstId,
  mergeShapes,
  notRequestedReason,
  shapeOf
} from '../../scripts/check-response-shapes.js';

test('shapeOf: keys and types, never values', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', c: null, d: true }), {
    a: 'string',
    b: 'number',
    c: 'null',
    d: 'boolean'
  });
});

test('shapeOf: a list is the merged shape of its elements; an empty list has none', () => {
  assert.deepEqual(
    shapeOf({
      items: [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 }
      ]
    }),
    {
      items: [{ id: 'string', n: 'number' }]
    }
  );
  assert.deepEqual(shapeOf({ items: [] }), { items: [] });
});

test('mergeShapes: a key some elements lack is marked optional', () => {
  assert.deepEqual(shapeOf([{ id: 'a', note: 'x' }, { id: 'b' }]), [
    { id: 'string', 'note?': 'string' }
  ]);
});

test('mergeShapes: different types are joined', () => {
  assert.equal(mergeShapes(['string', 'number']), 'number|string');
});

test('shapeOf: nesting is cut off at three levels', () => {
  assert.deepEqual(shapeOf({ a: { b: { c: { d: 1 } } } }), { a: { b: { c: 'object' } } });
});

test('diffSnapshots: a renamed key is reported with both shapes', () => {
  // The bug class this check is for: the answer said `connections`, now says `items`.
  const before = { 'GET /api/x': { status: 200, shape: { connections: [{ id: 'string' }] } } };
  const after = { 'GET /api/x': { status: 200, shape: { items: [{ id: 'string' }] } } };
  const lines = diffSnapshots(before, after);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GET \/api\/x/);
  assert.match(lines[0], /connections/);
  assert.match(lines[0], /items/);
});

test('diffSnapshots: new and removed routes, and no difference when equal', () => {
  const a = { 'GET /a': { status: 200, shape: 'string' } };
  assert.deepEqual(diffSnapshots(a, a), []);
  assert.match(diffSnapshots({}, a)[0], /^\+ GET \/a/);
  assert.match(diffSnapshots(a, {})[0], /^- GET \/a/);
});

test('diffSnapshots: a route that started answering an error is a difference', () => {
  const ok = { 'GET /a': { status: 200, shape: { x: 'string' } } };
  const bad = { 'GET /a': { status: 403, shape: { code: 'string' } } };
  assert.equal(diffSnapshots(ok, bad).length, 1);
});

test('firstId: items, a bare list, a keyed list inside an object', () => {
  assert.equal(firstId({ items: [{ id: 'one' }, { id: 'two' }] }), 'one');
  assert.equal(firstId([{ name: 'n1' }]), 'n1');
  assert.equal(firstId({ clients: [{ clientId: 'c', id: 'cid' }] }), 'cid');
  assert.equal(firstId({ items: [] }), null);
  assert.equal(firstId({ other: 1 }), null);
});

test('notRequestedReason: streams, downloads and external specifications are left alone', () => {
  assert.ok(notRequestedReason('/api/runs/:runId/events/stream'));
  assert.ok(notRequestedReason('/api/admin/browser-extension/download.zip'));
  assert.ok(notRequestedReason('/api/oauth/token'));
  assert.equal(notRequestedReason('/api/admin/apps'), null);
});
