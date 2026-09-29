import { useCallback, useEffect, useState } from 'react';
import { fetchApps } from '../../../api';

/**
 * The apps the signed-in pane user may open, loaded once per mount.
 *
 * `fetchApps` goes through the add-in's token, so the list is already narrowed
 * to what the add-in offers (its OAuth client's allowed apps) and to what the
 * user's groups allow.
 *
 * @returns {{ apps: object[], loading: boolean, error: boolean, retry: () => void }}
 *   `retry` loads the list again after a failure.
 */
export default function useOfficeApps() {
  const [state, setState] = useState({ apps: [], loading: true, error: false });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setState({ apps: [], loading: true, error: false });
    setAttempt(value => value + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchApps()
      .then(data => {
        if (!mounted) return;
        setState({ apps: Array.isArray(data) ? data : [], loading: false, error: false });
      })
      .catch(() => {
        if (mounted) setState({ apps: [], loading: false, error: true });
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);

  return { ...state, retry };
}
