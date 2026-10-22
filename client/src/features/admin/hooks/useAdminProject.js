// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAdminProject, getAdminApiErrorMessage } from '../../../api/adminApi';
import { ITEM_POLL_INTERVAL_MS, hasActiveItems } from '../utils/projectAdmin';

/**
 * Loads one admin project and keeps its items current: while any item is
 * `pending` or `extracting`, the project is read again every
 * {@link ITEM_POLL_INTERVAL_MS} ms until every item has settled.
 *
 * Polling is silent: it neither sets `loading` nor replaces a shown error,
 * and a failed poll simply tries again on the next tick.
 *
 * @param {string|null} projectId - `null` (a project being created) loads nothing.
 * @returns {{
 *   project: Object|null,
 *   setProject: (updater: Object|((prev: Object|null) => Object|null)) => void,
 *   loading: boolean,
 *   error: string|null,
 *   reload: () => Promise<Object|null>
 * }}
 *
 * @example
 * const { project, reload } = useAdminProject(id);
 * await addAdminProjectItem(id, body);
 * await reload(); // polling starts by itself when the new item is pending
 */
export function useAdminProject(projectId) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(null);
  // Ignore answers for a project the page no longer shows.
  const currentIdRef = useRef(projectId);
  currentIdRef.current = projectId;

  const reload = useCallback(async () => {
    if (!projectId) return null;
    try {
      const loaded = await fetchAdminProject(projectId);
      if (currentIdRef.current !== projectId) return null;
      setProject(loaded);
      setError(null);
      return loaded;
    } catch (err) {
      if (currentIdRef.current === projectId) setError(getAdminApiErrorMessage(err));
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload().finally(() => {
      if (currentIdRef.current === projectId) setLoading(false);
    });
  }, [projectId, reload]);

  const items = project?.items;
  useEffect(() => {
    if (!projectId || !hasActiveItems(items)) return undefined;
    // A poll already in flight when the items change (a delete, a pin, a
    // reload) is stale by the time it answers: its result must not put the
    // older snapshot back over the newer state.
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const loaded = await fetchAdminProject(projectId);
        if (live && currentIdRef.current === projectId) setProject(loaded);
      } catch (err) {
        // A failed poll keeps the items, but as a new array so this effect
        // re-arms and tries again after the interval.
        console.error('Failed to refresh project items:', err);
        if (live && currentIdRef.current === projectId) {
          setProject(prev => (prev ? { ...prev, items: [...(prev.items || [])] } : prev));
        }
      }
    }, ITEM_POLL_INTERVAL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId, items]);

  return { project, setProject, loading, error, reload };
}

export default useAdminProject;
