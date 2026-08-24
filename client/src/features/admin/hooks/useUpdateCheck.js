import { useEffect, useState } from 'react';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';

/** How long to wait before asking again while the server refreshes in the background. */
const POLL_INTERVAL_MS = 3000;
/** Give up polling after this many attempts so a stuck backend can't poll forever. */
const MAX_ATTEMPTS = 5;

/**
 * Fetches `/admin/version/check-update` on its own, independent of whatever
 * else a page is loading.
 *
 * The server answers this endpoint from a cache and refreshes in the
 * background, so a cold cache comes back as `checking: true` with no result
 * yet — this hook polls a few times to pick the result up without a reload.
 *
 * Keep this OUT of any request batch a page blocks its first render on: the
 * check reaches api.github.com, which is unreachable in deployments without
 * outbound internet access (issue #2150).
 *
 * @param {Object} [options]
 * @param {boolean} [options.enabled] - Set false to skip the check entirely,
 *   e.g. for content-admin-only users who aren't permitted on this endpoint.
 */
export function useUpdateCheck({ enabled = true } = {}) {
  const [updateInfo, setUpdateInfo] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timer = null;

    const run = async attempt => {
      try {
        const response = await makeAdminApiCall('/admin/version/check-update', { method: 'GET' });
        if (cancelled) return;

        const data = response?.data ?? null;
        setUpdateInfo(data);

        if (data?.checking && attempt < MAX_ATTEMPTS) {
          timer = setTimeout(() => run(attempt + 1), POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        setUpdateInfo({ updateAvailable: false, error: getAdminApiErrorMessage(error) });
      }
    };

    run(1);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return { updateInfo, setUpdateInfo };
}
