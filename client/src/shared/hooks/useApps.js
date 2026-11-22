// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import { fetchApps, fetchUserApps } from '../../api';
import useAuthKey from './useAuthKey';
import { useUserAppsAvailability } from './useUserApps';

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

/** The marker a cache key carries when the list also holds personal apps. */
const PERSONAL_KEY_SUFFIX = '|personal';

/**
 * The personal apps of the viewer, for the merged list. A failure here must
 * not take the admin apps away, so it reads as "none".
 */
const loadPersonalApps = () =>
  fetchUserApps({ scope: 'personal' })
    .then(items => (Array.isArray(items) ? items : []))
    .catch(error => {
      console.error('Error loading personal apps:', error);
      return [];
    });

/**
 * One list of admin apps and personal apps. A personal app never has the ID
 * of an admin app; should the server ever send both, the admin app wins.
 */
function mergeApps(adminApps, personalApps) {
  if (personalApps.length === 0) return adminApps;
  const known = new Set(adminApps.map(app => app?.id));
  return [...adminApps, ...personalApps.filter(app => app?.id && !known.has(app.id))];
}

function loadApps(key) {
  if (freshHit(key)) return Promise.resolve(cache.apps);
  if (cache && cache.key === key && cache.promise) return cache.promise;
  const previous = cache && cache.key === key ? cache : null;
  const withPersonal = key.endsWith(PERSONAL_KEY_SUFFIX);
  const promise = Promise.all([fetchApps(), withPersonal ? loadPersonalApps() : []])
    .then(([data, personal]) => {
      const apps = mergeApps(Array.isArray(data) ? data : [], personal);
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
 * Load the apps the current user can access. With the feature `userApps` on
 * the list also holds the viewer's personal apps (`ownership: 'user'`), their
 * own and those shared with them, so every consumer finds them by ID. Waits until authentication has
 * resolved (one request instead of anonymous-then-authenticated), refetches
 * when the user changes, and stays in sync with other consumers.
 *
 * @returns {{ apps: object[], loading: boolean, error: Error|null }}
 */
export default function useApps() {
  const authKey = useAuthKey();
  const { enabled: personal } = useUserAppsAvailability();
  const key = authKey && personal ? `${authKey}${PERSONAL_KEY_SUFFIX}` : authKey;
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
