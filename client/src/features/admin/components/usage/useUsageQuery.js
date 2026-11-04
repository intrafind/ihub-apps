// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';

const AUTO_REFRESH_MS = 30 * 1000;

/**
 * Load a usage report and keep the previous answer on screen while a new one
 * loads (a small indicator instead of a blank page). An answer that arrives
 * after the parameters changed again is dropped.
 *
 * @param {(params: Object) => Promise<Object>} fetcher
 * @param {Object} params - stable object (memoized by the caller)
 * @param {{autoRefresh?: boolean, enabled?: boolean}} [options]
 */
export default function useUsageQuery(
  fetcher,
  params,
  { autoRefresh = false, enabled = true } = {}
) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const key = JSON.stringify(params);

  const load = useCallback(async () => {
    const mine = ++seqRef.current;
    setLoading(true);
    try {
      const result = await fetcher(JSON.parse(key));
      if (mine !== seqRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (mine !== seqRef.current) return;
      setError(err);
    } finally {
      if (mine === seqRef.current) setLoading(false);
    }
  }, [fetcher, key]);

  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, autoRefresh, enabled]);

  return { data, error, loading, reload: load };
}
