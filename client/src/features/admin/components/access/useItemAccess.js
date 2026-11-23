// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchItemAccess, getAdminApiErrorMessage } from '../../../../api/adminApi';

/**
 * The full-admin access view of one item (`GET /api/admin/access/{type}/{id}`):
 * every group with how it gets the item, the audience, and whether the
 * restrict action applies.
 *
 * @param {object} options
 * @param {string} options.type - `apps`, `models`, …
 * @param {string} options.id - The item id; nothing is loaded without one
 * @param {unknown} [options.refreshKey] - Loads again whenever it changes (after
 *   another part of the page changed group access)
 * @param {(type: string, id: string) => Promise<object>} [options.load] - The request,
 *   injectable for tests
 * @returns {{view: object|null, loading: boolean, error: string|null,
 *   reload: () => Promise<void>, setView: (view: object) => void}}
 */
export function useItemAccess({ type, id, refreshKey, load = fetchItemAccess }) {
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    if (!id) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = await loadRef.current(type, id);
      if (request !== requestRef.current) return;
      setView(next);
      setError(null);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(getAdminApiErrorMessage(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [type, id]);

  useEffect(() => {
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload, refreshKey]);

  /** A view the page got from a write is newer than any load still on its way. */
  const replaceView = useCallback(next => {
    requestRef.current += 1;
    setView(next);
    setLoading(false);
    setError(null);
  }, []);

  return { view, loading, error, reload, setView: replaceView };
}

export default useItemAccess;
