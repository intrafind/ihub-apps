import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import { fetchComplianceBanner } from '../../../api/aiTransparencyAdminApi';

/**
 * Loads the admin compliance banner (`GET /admin/ai-transparency/banner`).
 *
 * Does nothing while `enabled` is false — callers pass
 * `isComplianceBannerUser(user)` so non-admins never trigger the request.
 * A failed request is kept in `error` and the banner simply stays hidden: the
 * banner is a hint, not a page, and must never break the start page.
 *
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true]
 * @returns {{banner: Object|null, error: string|null, reload: () => Promise<void>}}
 */
export function useComplianceBanner({ enabled = true } = {}) {
  const [banner, setBanner] = useState(null);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await fetchComplianceBanner();
      if (!mountedRef.current) return;
      setBanner(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getAdminApiErrorMessage(err));
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) reload();
    return () => {
      mountedRef.current = false;
    };
  }, [enabled, reload]);

  // A banner loaded while enabled is never shown after `enabled` turns false
  // (e.g. the admin signed out).
  return { banner: enabled ? banner : null, error: enabled ? error : null, reload };
}

export default useComplianceBanner;
