// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { renderHook, act } from '@testing-library/react';
import { useCursorPager } from '../../../client/src/shared/hooks/useCursorPager';

describe('useCursorPager', () => {
  it('steps forward and back through the cursors it was given', () => {
    const { result } = renderHook(() => useCursorPager('a'));
    expect(result.current).toMatchObject({ cursor: null, page: 1, hasPrevious: false });

    act(() => result.current.goNext('c2'));
    act(() => result.current.goNext('c3'));
    expect(result.current).toMatchObject({ cursor: 'c3', page: 3, hasPrevious: true });

    act(() => result.current.goPrevious());
    expect(result.current).toMatchObject({ cursor: 'c2', page: 2 });
  });

  it('ignores a missing next cursor', () => {
    const { result } = renderHook(() => useCursorPager());
    act(() => result.current.goNext(null));
    expect(result.current.page).toBe(1);
  });

  it('starts at the first page when the key changes, and stays there when it changes back', () => {
    const { result, rerender } = renderHook(({ k }) => useCursorPager(k), {
      initialProps: { k: 'filter-a' }
    });
    act(() => result.current.goNext('c2'));
    act(() => result.current.goNext('c3'));
    expect(result.current.page).toBe(3);

    rerender({ k: 'filter-b' });
    expect(result.current).toMatchObject({ cursor: null, page: 1 });

    // Back to the first filter without paging under the second: page 1, not the old page 3.
    rerender({ k: 'filter-a' });
    expect(result.current).toMatchObject({ cursor: null, page: 1, hasPrevious: false });
  });

  it('reset returns to the first page', () => {
    const { result } = renderHook(() => useCursorPager('a'));
    act(() => result.current.goNext('c2'));
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ cursor: null, page: 1 });
  });
});
