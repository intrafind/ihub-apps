// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchEuAiActStatus } from '../../../api/euAiActAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';

/**
 * Loads the configuration check once and again on demand. No polling: the page
 * is a snapshot plus a "Check again" button; actions on the page call
 * `reload()` so the rows follow.
 *
 * @returns {{status: Object|null, loading: boolean, checking: boolean, error: string|null,
 *   reload: (options?: {refresh?: boolean}) => Promise<void>}}
 */
export function useEuAiActStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const reload = useCallback(async ({ refresh = false } = {}) => {
    setChecking(true);
    try {
      const next = await fetchEuAiActStatus({ refresh });
      if (!aliveRef.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (aliveRef.current) setError(getAdminApiErrorMessage(err));
    } finally {
      if (aliveRef.current) {
        setLoading(false);
        setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  return { status, loading, checking, error, reload };
}

export default useEuAiActStatus;
