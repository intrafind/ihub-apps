import { useSyncExternalStore } from 'react';
import { getRecentAppIds, subscribeToRecentApps } from '../../utils/recentApps';

const EMPTY = [];

const sameOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

// `useSyncExternalStore` re-renders whenever the snapshot changes identity, so
// the array has to be cached and only replaced when the order actually moved.
let snapshot = EMPTY;

const getSnapshot = () => {
  const next = getRecentAppIds();
  if (!sameOrder(snapshot, next)) snapshot = next;
  return snapshot;
};

const getEmpty = () => EMPTY;
const noSubscription = () => () => {};

/**
 * Recently used app ids, most recent first, kept live.
 *
 * The sidebar is mounted once in the Layout and never unmounts, so reading
 * localStorage on mount left its `recent` ranking frozen at whatever it was
 * when the app booted. Subscribing instead keeps it current — including when
 * the app was opened in another tab.
 *
 * @param {boolean} [enabled=true] - Pass `false` when the caller does not rank
 *   by recent use; the hook then reports an empty list and does not subscribe.
 * @returns {string[]} The recently used app ids.
 */
export default function useRecentAppIds(enabled = true) {
  return useSyncExternalStore(
    enabled ? subscribeToRecentApps : noSubscription,
    enabled ? getSnapshot : getEmpty
  );
}
