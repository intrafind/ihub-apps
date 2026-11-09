// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Removing several project items at once: one call per item in order, an
 * item already gone counts as removed, a failure does not stop the rest, and
 * the caller learns which item is being removed.
 */
const {
  isItemGone,
  removeItemsInTurn,
  withoutItems
} = require('../../../client/src/features/projects/utils/removeItems');

const problem = (status, code) =>
  Object.assign(new Error(code), { response: { status, data: { code, detail: code } } });

describe('removeItemsInTurn', () => {
  test('removes in order, counts a gone item as removed and reports the others', async () => {
    const calls = [];
    const busy = [];
    const removeOne = jest.fn(async item => {
      calls.push(item.id);
      if (item.id === 'b') throw problem(404, 'ITEM_NOT_FOUND');
      if (item.id === 'c') throw problem(403, 'PERMISSION_DENIED');
    });

    const result = await removeItemsInTurn(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      removeOne,
      {
        messageOf: error => `failed: ${error.message}`,
        onItem: item => busy.push(item?.id ?? null)
      }
    );

    expect(calls).toEqual(['a', 'b', 'c', 'd']);
    expect([...result.removed]).toEqual(['a', 'b', 'd']);
    expect(result.failed).toEqual(['failed: PERMISSION_DENIED']);
    expect(busy).toEqual(['a', 'b', 'c', 'd', null]);
  });

  test('a missing project is a failure, not an item that is gone', () => {
    expect(isItemGone(problem(404, 'PROJECT_NOT_FOUND'))).toBe(false);
    expect(isItemGone(problem(404, 'ITEM_NOT_FOUND'))).toBe(true);
    // The enhanced error of the user API keeps the response under `originalError`.
    expect(
      isItemGone({ originalError: { response: { status: 404, data: { code: 'ITEM_NOT_FOUND' } } } })
    ).toBe(true);
  });
});

describe('withoutItems', () => {
  test('drops the given items and leaves an empty set or no project alone', () => {
    const project = { id: 'p', items: [{ id: 'a' }, { id: 'b' }] };
    expect(withoutItems(project, new Set(['a'])).items).toEqual([{ id: 'b' }]);
    expect(withoutItems(project, new Set())).toBe(project);
    expect(withoutItems(null, new Set(['a']))).toBeNull();
  });
});
