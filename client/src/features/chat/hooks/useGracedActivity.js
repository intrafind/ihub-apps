// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { isPainted, paintsIn } from '../activityTiming.js';

/**
 * The activity of a turn without the rows that may not be shown yet (issue
 * #3534). A call whose arguments are still being written gets its row only
 * after `PREPARING_GRACE_MS`, so a call the model finishes writing in less (a
 * tiny file the server announces at once) never flickers through a
 * "preparing" row; a call refused before that is never shown as failed
 * either. Every other row shows at once, and a row that has been shown is
 * never taken away.
 *
 * The turn's line (the idle line, the three-dot loader) is decided on what
 * this returns, so a row still in its grace period does not take the loader
 * away from a screen that shows nothing else yet.
 *
 * @param {Object|null|undefined} activity - the message's `toolActivity`
 * @returns {Object|null} the same object when every row shows; else a copy
 *   without the rows that do not (null when nothing is left to show)
 */
export function useGracedActivity(activity) {
  const [now, setNow] = useState(() => performance.now());

  // Wake up when the next row's grace ends: its frame brought no re-render of its own.
  useEffect(() => {
    const clock = performance.now();
    const items = activity?.items || [];
    // A grace that ended before this effect ran (a long render, a throttled
    // background tab): the stored clock is behind, so catch it up at once. No
    // timer would be set for a grace that is over, and the row would stay hidden
    // while the screen-reader announcer already speaks for it.
    if (items.some(item => !isPainted(item, now) && isPainted(item, clock))) {
      setNow(clock);
      return undefined;
    }
    const waits = items.map(item => paintsIn(item, clock)).filter(wait => wait !== null);
    if (waits.length === 0) return undefined;
    const timer = setTimeout(() => setNow(performance.now()), Math.min(...waits) + 1);
    return () => clearTimeout(timer);
  }, [activity, now]);

  return useMemo(() => {
    if (!activity) return null;
    const items = activity.items.filter(item => isPainted(item, now));
    if (items.length === activity.items.length) return activity;
    return items.length === 0 && !activity.idle ? null : { ...activity, items };
  }, [activity, now]);
}

export default useGracedActivity;
