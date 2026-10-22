// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The state of the "Estimate tokens" button: runs the estimate call, keeps
 * its result (also by item id, for the items table) and the error. A result
 * that arrives after the call changed (another project) or after a newer run
 * is dropped, and a new call starts without the old project's result.
 *
 * @param {() => Promise<Object>} estimateCall - Resolves with the estimate of
 *   `services/projects/projectEstimate.js`.
 * @param {(error: Error) => string} errorMessage
 * @returns {{estimate: Object|null, byItem: Object, loading: boolean, error: string|null,
 *   run: () => Promise<void>, clear: () => void}}
 */
export function useProjectEstimate(estimateCall, errorMessage) {
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  // Another project (a new `estimateCall`) invalidates the result and any
  // request still in flight.
  useEffect(() => {
    generation.current += 1;
    setEstimate(null);
    setError(null);
    setLoading(false);
  }, [estimateCall]);

  const run = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await estimateCall();
      if (mine === generation.current) setEstimate(result);
    } catch (err) {
      if (mine === generation.current) {
        setEstimate(null);
        setError(errorMessage(err));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [estimateCall, errorMessage]);

  // Drops the result, and with it any request in flight: the items changed.
  const clear = useCallback(() => {
    generation.current += 1;
    setEstimate(null);
    setError(null);
    setLoading(false);
  }, []);

  const byItem = Object.fromEntries((estimate?.items || []).map(entry => [entry.id, entry]));
  return { estimate, byItem, loading, error, run, clear };
}

export default useProjectEstimate;
