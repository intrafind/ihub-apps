// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';

/**
 * The state of the "Estimate tokens" button: runs the estimate call, keeps
 * its result (also by item id, for the items table) and the error.
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

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEstimate(await estimateCall());
    } catch (err) {
      setEstimate(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [estimateCall, errorMessage]);

  const clear = useCallback(() => {
    setEstimate(null);
    setError(null);
  }, []);

  const byItem = Object.fromEntries((estimate?.items || []).map(entry => [entry.id, entry]));
  return { estimate, byItem, loading, error, run, clear };
}

export default useProjectEstimate;
