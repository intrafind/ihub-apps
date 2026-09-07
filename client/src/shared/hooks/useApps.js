import { useState, useEffect } from 'react';
import { fetchApps } from '../../api';
import { useAuth } from '../contexts/AuthContext';

// The sidebar and the start page mount together and both need the apps list.
// Share one in-flight request (and its result for a short while) per user so a
// navigation to "/" does not hit /api/apps once per component.
const CACHE_TTL_MS = 30_000;
let cache = null; // { key, promise, apps, at }

function freshHit(key) {
  return cache && cache.key === key && cache.apps && Date.now() - cache.at < CACHE_TTL_MS;
}

function loadApps(key) {
  if (freshHit(key)) return Promise.resolve(cache.apps);
  if (cache && cache.key === key && cache.promise) return cache.promise;
  const promise = fetchApps()
    .then(data => {
      const apps = Array.isArray(data) ? data : [];
      cache = { key, apps, at: Date.now(), promise: null };
      return apps;
    })
    .catch(error => {
      if (cache && cache.promise === promise) cache = null;
      throw error;
    });
  cache = { key, promise, apps: null, at: 0 };
  return promise;
}

/** Drop the shared apps cache (e.g. after an admin changes apps). */
export function invalidateAppsCache() {
  cache = null;
}

/**
 * Load the apps the current user can access. Refetches when the authenticated
 * user changes (login/logout) so the list is never stale after auth changes.
 *
 * @returns {{ apps: object[], loading: boolean, error: Error|null }}
 */
export default function useApps() {
  const { user, isAuthenticated } = useAuth();
  const key = `${isAuthenticated ? 'auth' : 'anon'}:${user?.id ?? ''}`;
  const [state, setState] = useState(() => ({
    apps: freshHit(key) ? cache.apps : [],
    loading: !freshHit(key),
    error: null
  }));

  useEffect(() => {
    let mounted = true;
    if (!freshHit(key)) {
      setState(prev => (prev.loading ? prev : { ...prev, loading: true }));
    }
    loadApps(key)
      .then(apps => {
        if (mounted) setState({ apps, loading: false, error: null });
      })
      .catch(error => {
        if (mounted) setState(prev => ({ apps: prev.apps, loading: false, error }));
      });
    return () => {
      mounted = false;
    };
  }, [key]);

  return state;
}
