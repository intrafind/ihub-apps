// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  limitFrom,
  nextOffsetCursor,
  offsetCursor,
  offsetFromCursor,
  pageOfList
} from '../utils/pagination.js';

describe('cursor paging helpers', () => {
  it('round-trips a position and treats no cursor as the start', () => {
    assert.equal(offsetFromCursor(offsetCursor(40)), 40);
    assert.equal(offsetFromCursor(undefined), 0);
    assert.equal(offsetFromCursor(''), 0);
  });

  it('refuses a cursor it did not hand out', () => {
    for (const bad of ['!!', 'e30', Buffer.from('{"o":-1}').toString('base64url')]) {
      assert.throws(
        () => offsetFromCursor(bad),
        error => error.code === 'INVALID_CURSOR' && error.status === 400
      );
    }
  });

  it('caps a limit instead of refusing it', () => {
    assert.equal(limitFrom('500', { fallback: 20, max: 100 }), 100);
    assert.equal(limitFrom(undefined, { fallback: 20, max: 100 }), 20);
    assert.equal(limitFrom('0', { fallback: 20, max: 100 }), 20);
    assert.equal(limitFrom('7', { fallback: 20, max: 100 }), 7);
  });

  it('pages a list to its end, where nextCursor is null', () => {
    const list = [1, 2, 3, 4, 5];
    const first = pageOfList(list, { limit: 2 });
    assert.deepEqual(first.items, [1, 2]);
    const second = pageOfList(list, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.items, [3, 4]);
    const last = pageOfList(list, { limit: 2, cursor: second.nextCursor });
    assert.deepEqual(last, { items: [5], nextCursor: null });
    assert.equal(nextOffsetCursor({ offset: 3, limit: 2, total: 5 }), null);
  });
});
