// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `useGracedActivity` (issue #3534): a row whose call is still writing its
 * arguments is shown only after `PREPARING_GRACE_MS`. The hook keeps its own
 * clock in state, and the effect that wakes it measures against a fresh
 * `performance.now()`; these tests pin the case where the two disagree.
 */
import { renderHook } from '@testing-library/react';
import { useGracedActivity } from '../../../client/src/features/chat/hooks/useGracedActivity';
import { PREPARING_GRACE_MS } from '../../../client/src/features/chat/activityConstants';

describe('useGracedActivity', () => {
  let clock;

  beforeEach(() => {
    clock = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const preparing = firstReceivedAt => ({
    items: [{ id: 'c1', status: 'preparing', firstReceivedAt }]
  });

  test('a row still inside its grace period is not shown yet', () => {
    const { result, rerender } = renderHook(({ activity }) => useGracedActivity(activity), {
      initialProps: { activity: null }
    });
    clock = 1100 + PREPARING_GRACE_MS - 100;
    rerender({ activity: preparing(1100) });
    expect(result.current).toBeNull();
  });

  test('a row whose grace already ended when its frame is first handled is shown at once', () => {
    // The hook mounted at 1000 and its clock stayed there; the first frame was
    // stamped at 1100 and the effect only runs after the grace is over (a long
    // render, a throttled background tab). No timer would ever be set for it.
    const { result, rerender } = renderHook(({ activity }) => useGracedActivity(activity), {
      initialProps: { activity: null }
    });
    clock = 1100 + PREPARING_GRACE_MS + 50;
    rerender({ activity: preparing(1100) });
    expect(result.current?.items).toHaveLength(1);
    expect(result.current.items[0].id).toBe('c1');
  });

  test('rows that were never held back are returned as they are', () => {
    const activity = { items: [{ id: 'r1', status: 'completed' }] };
    const { result } = renderHook(() => useGracedActivity(activity));
    expect(result.current).toBe(activity);
  });
});
