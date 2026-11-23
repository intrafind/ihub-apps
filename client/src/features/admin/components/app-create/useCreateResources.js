// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';

const normalized = text =>
  String(text ?? '')
    .trim()
    .toLowerCase();

/**
 * What the "New app" page needs to know about the installation before the
 * author's first click: the models (is one set up?), the apps that exist
 * (which IDs and names are taken?) and the UI configuration (the categories).
 *
 * Each list is loaded once through the caller's function. A list that cannot
 * be loaded is `null`: the page then works without that knowledge, and the
 * server stays the authority.
 *
 * @param {object} sources
 * @param {() => Promise<object[]>} sources.fetchModels - The models the author may use.
 * @param {() => Promise<object[]>} sources.fetchApps - Every app, with `id` and `name`.
 * @param {() => Promise<object>} sources.fetchUiConfig
 * @returns {{
 *   models: object[]|null|undefined,
 *   apps: object[]|null|undefined,
 *   appsReady: boolean,
 *   uiConfig: object|null,
 *   isTaken: (id: string) => boolean,
 *   nameExists: (name: string) => boolean,
 *   markTaken: (id: string) => void
 * }} `undefined` means "still loading".
 */
export function useCreateResources({ fetchModels, fetchApps, fetchUiConfig }) {
  const [models, setModels] = useState(undefined);
  const [apps, setApps] = useState(undefined);
  const [uiConfig, setUiConfig] = useState(null);
  // IDs the server reported as taken after the list was loaded.
  const [alsoTaken, setAlsoTaken] = useState([]);

  useEffect(() => {
    let current = true;
    const load = (fetcher, apply, fallback) =>
      Promise.resolve()
        .then(fetcher)
        .then(value => current && apply(value))
        .catch(() => current && apply(fallback));
    void load(fetchModels, value => setModels(Array.isArray(value) ? value : null), null);
    void load(fetchApps, value => setApps(Array.isArray(value) ? value : null), null);
    void load(fetchUiConfig, value => setUiConfig(value || null), null);
    return () => {
      current = false;
    };
  }, [fetchModels, fetchApps, fetchUiConfig]);

  const ids = useMemo(
    () => new Set([...(apps || []).map(app => normalized(app?.id)), ...alsoTaken]),
    [apps, alsoTaken]
  );
  const names = useMemo(() => {
    const all = new Set();
    for (const app of apps || []) {
      const name = app?.name;
      const texts = typeof name === 'string' ? [name] : Object.values(name || {});
      for (const text of texts) {
        if (normalized(text)) all.add(normalized(text));
      }
    }
    return all;
  }, [apps]);

  const isTaken = useCallback(id => ids.has(normalized(id)), [ids]);
  const nameExists = useCallback(name => names.has(normalized(name)), [names]);
  const markTaken = useCallback(
    id =>
      setAlsoTaken(taken => (taken.includes(normalized(id)) ? taken : [...taken, normalized(id)])),
    []
  );

  return {
    models,
    apps,
    appsReady: apps !== undefined,
    uiConfig,
    isTaken,
    nameExists,
    markTaken
  };
}

export default useCreateResources;
