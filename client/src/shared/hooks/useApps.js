import { useState, useEffect } from 'react';
import { fetchApps } from '../../api';
import { useAuth } from '../contexts/AuthContext';

/**
 * Load the apps the current user can access. Refetches when the authenticated
 * user changes (login/logout) so the list is never stale after auth changes.
 *
 * @returns {{ apps: object[], loading: boolean }}
 */
export default function useApps() {
  const { user, isAuthenticated } = useAuth();
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchApps()
      .then(data => {
        if (mounted && Array.isArray(data)) setApps(data);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAuthenticated, user?.id]);

  return { apps, loading };
}
