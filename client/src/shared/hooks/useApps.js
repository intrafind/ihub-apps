import { useState, useEffect } from 'react';
import { fetchApps } from '../../api';
import useAuthKey from './useAuthKey';

// The sidebar, the start page and the apps browser all need the apps list.
// One module-level store shares a single in-flight request per user, keeps
// the result for a short while, and tells every mounted consumer when fresh
// data arrives — so the sidebar (mounted once in Layout) picks up a refetch
// triggered by a page that mounted later.
const CACHE_TTL_MS = 30_000;
let cache = null; // { key, promise, apps, at }
const listeners = new Set();

const freshHit = key =>
  !!(cache && cache.key === key && cache.apps && Date.now() - cache.at < CACHE_TTL_MS);
const notify = () => listeners.forEach(listener => listener());

function loadApps(key) {
  if (freshHit(key)) return Promise.resolve(cache.apps);
  if (cache && cache.key === key && cache.promise) return cache.promise;
  const previous = cache && cache.key === key ? cache : null;
  const promise = fetchApps()
    .then(data => {
      const apps = Array.isArray(data) ? data : [];
      cache = { key, apps, at: Date.now(), promise: null };
      notify();
      return apps;
    })
    .catch(error => {
      if (cache && cache.promise === promise) cache = previous;
      throw error;
    });
  cache = { key, promise, apps: previous?.apps ?? null, at: previous?.at ?? 0 };
  return promise;
}

/** Drop the shared apps cache and make every mounted consumer refetch. */
export function invalidateAppsCache() {
  cache = null;
  notify();
}

/**
 * Load the apps the current user can access. Waits until authentication has
 * resolved (one request instead of anonymous-then-authenticated), refetches
 * when the user changes, and stays in sync with other consumers.
 *
 * @returns {{ apps: object[], loading: boolean, error: Error|null }}
 */
export default function useApps() {
  const key = useAuthKey();
  const [state, setState] = useState(() => ({
    apps: key && freshHit(key) ? cache.apps : [],
    loading: true,
    error: null
  }));

  useEffect(() => {
    if (!key) return undefined; // auth still resolving
    let mounted = true;
    const load = () => {
      setState(prev => (prev.loading ? prev : { ...prev, loading: true }));
      loadApps(key)
        .then(apps => {
          if (mounted) setState({ apps, loading: false, error: null });
        })
        .catch(error => {
          if (mounted) setState(prev => ({ apps: prev.apps, loading: false, error }));
        });
    };
    const sync = () => {
      if (!mounted) return;
      if (freshHit(key)) setState({ apps: cache.apps, loading: false, error: null });
      else load();
    };
    listeners.add(sync);
    sync();
    return () => {
      mounted = false;
      listeners.delete(sync);
    };
  }, [key]);

  return state;
}
