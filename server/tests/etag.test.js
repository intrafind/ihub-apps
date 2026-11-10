// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  etagForIds,
  etagWithSuffix,
  responseEtag,
  RESPONSE_SHAPE_REVISION,
  shortHash
} from '../utils/etag.js';

describe('etagWithSuffix', () => {
  it('puts the suffix inside the quotes of a quoted ETag', () => {
    assert.equal(etagWithSuffix('"abc"', 'x1'), '"abc-x1"');
  });

  it('appends the suffix to an ETag without quotes', () => {
    assert.equal(etagWithSuffix('abc', 'x1'), 'abc-x1');
    assert.equal(etagWithSuffix(null, 'x1'), 'null-x1');
  });
});

describe('etagForIds', () => {
  it('does not depend on the order of the ids', () => {
    assert.equal(etagForIds('"abc"', ['b', 'a', 'c']), etagForIds('"abc"', ['c', 'b', 'a']));
  });

  it('tells subsets apart and keeps the quotes balanced', () => {
    const one = etagForIds('"abc"', ['a']);
    const two = etagForIds('"abc"', ['a', 'b']);
    assert.notEqual(one, two);
    assert.match(one, /^"abc-[0-9a-f]{8}"$/);
  });

  it('hashes the sorted JSON array of ids and puts the prefix before the hash', () => {
    assert.equal(etagForIds('"abc"', ['b', 'a'], 'f'), `"abc-f${shortHash('["a","b"]')}"`);
  });

  it("does not reorder the caller's array", () => {
    const ids = ['b', 'a'];
    etagForIds('"abc"', ids);
    assert.deepEqual(ids, ['b', 'a']);
  });
});

describe('responseEtag', () => {
  it('differs from the config ETag it is built from, inside its quotes', () => {
    assert.equal(responseEtag('"abc"'), `"abc-r${RESPONSE_SHAPE_REVISION}"`);
    assert.notEqual(responseEtag('"abc"'), '"abc"');
  });

  it('is stable for the same config ETag', () => {
    assert.equal(responseEtag('"abc"'), responseEtag('"abc"'));
  });

  it('passes an empty ETag through, so no header is set for it', () => {
    assert.equal(responseEtag(null), null);
    assert.equal(responseEtag(undefined), undefined);
    assert.equal(responseEtag(''), '');
  });
});
