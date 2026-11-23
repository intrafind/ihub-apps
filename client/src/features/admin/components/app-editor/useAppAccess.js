// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';

const NOT_LOADED = Object.freeze({ loading: true, failed: false, view: null });

/**
 * Who can use an app, as the server's content-access view says it. The editor
 * page needs the view in three places: the publish dialog, the summary line of
 * the group "Who can use this app", and after the access section saved a
 * change.
 *
 * The request comes from the caller, so the hook names no endpoint.
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {(appId: string) => Promise<object>} options.loadAccess - Resolves with the
 *   content-access view `{ scope, groups, audience }`.
 * @returns {{
 *   access: {loading: boolean, failed: boolean, view: object|null},
 *   refreshAccess: () => Promise<void>,
 *   setAccessView: (view: object) => void
 * }} `view` is null until the first load answered, and after a failed load.
 *   While a refresh runs, the view of before stays.
 *
 * @example
 * const { access, refreshAccess, setAccessView } = useAppAccess({ appId, loadAccess });
 * <ContentAccessSection resourceType="apps" resourceId={appId} onSaved={setAccessView} />
 */
export function useAppAccess({ appId, loadAccess }) {
  const [state, setState] = useState({ appId: null, ...NOT_LOADED });
  const access = state.appId === appId ? state : NOT_LOADED;
  // The newest request wins; an answer that arrives late is dropped.
  const requestRef = useRef(0);

  const loadAccessRef = useRef(loadAccess);
  loadAccessRef.current = loadAccess;

  const refreshAccess = useCallback(async () => {
    const request = ++requestRef.current;
    setState(held => (held.appId === appId ? { ...held, loading: true } : held));
    try {
      const view = await loadAccessRef.current(appId);
      if (request !== requestRef.current) return;
      setState({ appId, loading: false, failed: false, view });
    } catch {
      if (request !== requestRef.current) return;
      setState({ appId, loading: false, failed: true, view: null });
    }
  }, [appId]);

  useEffect(() => {
    void refreshAccess();
    return () => {
      requestRef.current += 1;
    };
  }, [refreshAccess]);

  /** What the access section saved is newer than anything still on its way. */
  const setAccessView = useCallback(
    view => {
      requestRef.current += 1;
      setState({ appId, loading: false, failed: false, view });
    },
    [appId]
  );

  return { access, refreshAccess, setAccessView };
}

export default useAppAccess;
