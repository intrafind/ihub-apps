// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import useAuthKey from './useAuthKey';
import { useUserAppsAvailability } from './useUserApps';
import { PERSONAL_KEY_SUFFIX, cachedApps, freshHit, loadApps, subscribeApps } from './appsCache';

/**
 * Load the apps the current user can access. With the feature `userApps` on
 * the list also holds the viewer's personal apps (`ownership: 'user'`), their
 * own and those shared with them, so every consumer finds them by ID. The
 * list is shared through `appsCache.js`; `invalidateAppsCache` there makes
 * every consumer refetch. Waits until authentication has
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
    apps: key && freshHit(key) ? cachedApps() : [],
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
      if (freshHit(key)) setState({ apps: cachedApps(), loading: false, error: null });
      else load();
    };
    const unsubscribe = subscribeApps(sync);
    sync();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [key]);

  return state;
}
