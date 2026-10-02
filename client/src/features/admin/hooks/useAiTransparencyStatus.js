import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import { fetchAiTransparencyStatus } from '../../../api/aiTransparencyAdminApi';

/**
 * Loads the EU AI Act conformance status (`GET /admin/ai-transparency/status`)
 * for the `/admin/eu-ai-act` page.
 *
 * `loading` is only true for the first load. A `reload()` keeps the previous
 * status on screen (`refreshing` is true meanwhile), so tabs that hold local
 * form state are not unmounted after every save.
 *
 * @returns {{
 *   status: Object|null,
 *   loading: boolean,
 *   refreshing: boolean,
 *   error: string|null,
 *   reload: () => Promise<Object|null>
 * }} `reload` resolves with the new status, or null if the request failed
 *   (the error is then in `error`).
 *
 * @example
 * const { status, loading, error, reload } = useAiTransparencyStatus();
 * await acknowledgeUnmarkedModel(id, reason);
 * await reload();
 */
export function useAiTransparencyStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // Only the latest request may write state (a slow early reload must not
  // overwrite a newer one).
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    try {
      const data = await fetchAiTransparencyStatus();
      if (!mountedRef.current || requestId !== requestIdRef.current) return data;
      setStatus(data);
      setError(null);
      return data;
    } catch (err) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(getAdminApiErrorMessage(err));
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reload();
    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  return { status, loading, refreshing, error, reload };
}

export default useAiTransparencyStatus;
