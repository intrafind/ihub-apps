// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';

/**
 * Count down the wait a "Too many requests" (429) load error asks for, for
 * error panels whose data does not come from `useAdminConfigLoad` (which counts
 * down itself): the App and Model editors (`AdminEditPageShell`) and the
 * Overview banner. Pass the result to `AdminLoadError` as `retryAfterSeconds`;
 * the panel keeps Retry inert and labelled "Retry in N s" until it reaches 0.
 *
 * The wait starts whenever a new error object with `retryAfterSeconds` arrives,
 * so a Retry that runs into a 429 again starts a new countdown.
 *
 * @param {{retryAfterSeconds?: number|null}|null} error - The load error
 *   (from `describeAdminLoadError`), or null
 * @returns {number} Whole seconds left before Retry may be pressed (0 = now)
 *
 * @example
 * const retryAfterSeconds = useRetryCountdown(loadError);
 * <AdminLoadError … onRetry={retry} retryAfterSeconds={retryAfterSeconds} />
 */
export function useRetryCountdown(error) {
  const [tracked, setTracked] = useState({ error: null, secondsLeft: 0 });

  // A new error starts a new wait: adjust the state while rendering (React's
  // pattern for state derived from a changed prop) instead of in an effect.
  if (tracked.error !== error) {
    const seconds = Math.ceil(Number(error?.retryAfterSeconds) || 0);
    setTracked({ error, secondsLeft: Math.max(0, seconds) });
  }

  // One tick a second until the wait is over.
  useEffect(() => {
    if (tracked.secondsLeft <= 0) return undefined;
    const timer = setTimeout(
      () => setTracked(prev => ({ ...prev, secondsLeft: Math.max(0, prev.secondsLeft - 1) })),
      1000
    );
    return () => clearTimeout(timer);
  }, [tracked]);

  return tracked.error === error ? tracked.secondsLeft : 0;
}

export default useRetryCountdown;
