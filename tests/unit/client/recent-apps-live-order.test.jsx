import { renderHook, act } from '@testing-library/react';

import { createRecentItemHelpers } from '../../../client/src/utils/recentItems';
import {
  getRecentAppIds,
  recordAppUsage,
  subscribeToRecentApps
} from '../../../client/src/utils/recentApps';
import { recordPromptUsage } from '../../../client/src/utils/recentPrompts';
import useRecentAppIds from '../../../client/src/shared/hooks/useRecentAppIds';

/**
 * With the app shortcuts set to rank by recent use, the sidebar's Apps section
 * has to reorder as soon as an app is opened. The sidebar is mounted once in
 * the Layout and never unmounts, so a read on mount froze its ranking at
 * whatever it was when the page loaded (#2320) — it needs a subscription.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('recent item helpers', () => {
  test('recording usage notifies subscribers of this list only', () => {
    const onAppsChanged = jest.fn();
    const unsubscribe = subscribeToRecentApps(onAppsChanged);

    recordAppUsage('chat');
    expect(onAppsChanged).toHaveBeenCalledTimes(1);
    expect(getRecentAppIds()).toEqual(['chat']);

    // A different list (recent prompts) must not wake the apps subscribers.
    recordPromptUsage('summarize');
    expect(onAppsChanged).toHaveBeenCalledTimes(1);

    unsubscribe();
    recordAppUsage('translator');
    expect(onAppsChanged).toHaveBeenCalledTimes(1);
  });

  test('a write from another tab reaches subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToRecentApps(listener);

    window.dispatchEvent(new StorageEvent('storage', { key: 'ihub_recent_apps_default' }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Another key's storage event is not ours.
    window.dispatchEvent(new StorageEvent('storage', { key: 'ihub_favorite_apps' }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  test('a subscriber never sees an id it did not record', () => {
    const helpers = createRecentItemHelpers({ prefix: 'test_recent_' });
    const listener = jest.fn();
    const unsubscribe = helpers.subscribe(listener);

    // No id means no write and no notification.
    helpers.recordUsage('');
    expect(listener).not.toHaveBeenCalled();
    expect(helpers.getIds()).toEqual([]);

    unsubscribe();
  });
});

describe('useRecentAppIds', () => {
  test('reorders as apps are opened', () => {
    recordAppUsage('chat');
    const { result } = renderHook(() => useRecentAppIds(true));
    expect(result.current).toEqual(['chat']);

    act(() => recordAppUsage('translator'));
    expect(result.current).toEqual(['translator', 'chat']);

    act(() => recordAppUsage('chat'));
    expect(result.current).toEqual(['chat', 'translator']);
  });

  test('keeps the same array when the order did not change', () => {
    recordAppUsage('chat');
    const { result } = renderHook(() => useRecentAppIds(true));
    const first = result.current;

    // Re-opening the only app leaves the ranking untouched; handing back a new
    // array would re-sort the sidebar list on every navigation for nothing.
    act(() => recordAppUsage('chat'));
    expect(result.current).toBe(first);
  });

  test('reports nothing while the caller does not rank by recent use', () => {
    recordAppUsage('chat');
    const { result, rerender } = renderHook(({ enabled }) => useRecentAppIds(enabled), {
      initialProps: { enabled: false }
    });
    expect(result.current).toEqual([]);

    act(() => recordAppUsage('translator'));
    expect(result.current).toEqual([]);

    // Switching the mode on (the admin saved `appsMode: 'recent'`) picks the
    // list up without a reload.
    rerender({ enabled: true });
    expect(result.current).toEqual(['translator', 'chat']);
  });

  test('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => useRecentAppIds(true));
    unmount();
    // A write after unmount must not touch React state.
    expect(() => recordAppUsage('chat')).not.toThrow();
  });
});
