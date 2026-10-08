import { useCallback, useEffect, useState } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * Whether each model (or provider) has an API key the server can use.
 *
 * Reads `GET /admin/models/_key-status` or `/admin/providers/_key-status`:
 * per id, `{ state, source, envVar }` where `state` is `ok`, `keyless`,
 * `undecryptable` or `missing`. The key itself never reaches the browser.
 *
 * A failed read leaves `statuses` empty rather than raising: the status is a
 * hint next to a list or form, and nothing there depends on it.
 *
 * @param {'models'|'providers'} kind
 * @returns {{statuses: Object<string, {state: string, source: string, envVar: string|null}>,
 *   loading: boolean, reload: () => Promise<void>}}
 */
export default function useApiKeyStatus(kind = 'models') {
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const response = await makeAdminApiCall(`/admin/${kind}/_key-status`);
      setStatuses(response?.data?.statuses || {});
    } catch (error) {
      console.error(`Failed to load ${kind} API key status:`, error);
      setStatuses({});
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { statuses, loading, reload };
}
