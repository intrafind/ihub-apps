// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';

/**
 * A small shared store for one per-viewer resource (the projects
 * configuration, the project list): one in-flight request per viewer, the
 * result kept for a short while, and every mounted consumer told when fresh
 * data arrives. The same shape `useApps` uses, without its app specifics.
 *
 * @param {() => Promise<any>} loader - Loads the resource.
 * @param {{ttlMs?: number}} [options]
 * @returns {{use: (key: string|null, enabled: boolean) => {data: any, loading: boolean,
 *   error: Error|null, reload: () => Promise<any>}, invalidate: () => void}}
 *
 * @example
 * const configStore = createViewerStore(fetchProjectsConfig);
 * const { data } = configStore.use(authKey, userProjectsOn);
 */
export function createViewerStore(loader, { ttlMs = 30_000 } = {}) {
  let cache = null; // { key, data, at, promise }
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener());
  const fresh = key =>
    Boolean(cache && cache.key === key && cache.at && Date.now() - cache.at < ttlMs);

  const load = (key, force = false) => {
    if (!force && fresh(key)) return Promise.resolve(cache.data);
    if (cache && cache.key === key && cache.promise) return cache.promise;
    const previous = cache && cache.key === key ? cache : null;
    const promise = loader()
      .then(data => {
        cache = { key, data, at: Date.now(), promise: null };
        notify();
        return data;
      })
      .catch(error => {
        if (cache && cache.promise === promise) cache = previous;
        throw error;
      });
    cache = { key, data: previous?.data, at: previous?.at ?? 0, promise };
    return promise;
  };

  const invalidate = () => {
    cache = null;
    notify();
  };

  function use(key, enabled) {
    const [state, setState] = useState(() => ({
      data: key && fresh(key) ? cache.data : undefined,
      loading: Boolean(enabled),
      error: null
    }));

    useEffect(() => {
      if (!key || !enabled) {
        setState({ data: undefined, loading: false, error: null });
        return undefined;
      }
      let mounted = true;
      const sync = () => {
        if (!mounted) return;
        if (fresh(key)) {
          setState({ data: cache.data, loading: false, error: null });
          return;
        }
        setState(prev => (prev.loading ? prev : { ...prev, loading: true }));
        load(key)
          .then(data => mounted && setState({ data, loading: false, error: null }))
          .catch(error => mounted && setState(prev => ({ ...prev, loading: false, error })));
      };
      listeners.add(sync);
      sync();
      return () => {
        mounted = false;
        listeners.delete(sync);
      };
    }, [key, enabled]);

    return { ...state, reload: () => (key ? load(key, true) : Promise.resolve(undefined)) };
  }

  return { use, invalidate };
}

export default createViewerStore;
