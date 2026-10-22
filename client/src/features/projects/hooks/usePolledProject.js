// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { ITEM_POLL_INTERVAL_MS, hasActiveItems } from '../utils/projectItems';

/**
 * Loads one project and keeps its items current: while any item is
 * `pending` or `extracting`, or being refreshed (`refreshingAt`), the
 * project is read again every
 * {@link ITEM_POLL_INTERVAL_MS} ms until every item has settled. The admin
 * editor and the user project page share it; each passes its own loader.
 *
 * Polling is silent: it neither sets `loading` nor replaces a shown error,
 * and a failed poll simply tries again on the next tick.
 *
 * @param {string|null} projectId - `null` (a project being created) loads nothing.
 * @param {Object} options
 * @param {(projectId: string) => Promise<Object>} options.load - Reads the project.
 * @param {(error: Error) => string} options.errorMessage - Turns a failed read into a message.
 * @returns {{
 *   project: Object|null,
 *   setProject: (updater: Object|((prev: Object|null) => Object|null)) => void,
 *   loading: boolean,
 *   error: string|null,
 *   errorObject: Error|null,
 *   reload: () => Promise<Object|null>
 * }}
 *
 * @example
 * const { project, reload } = usePolledProject(id, { load: fetchProject, errorMessage });
 * await addProjectItem(id, body);
 * await reload(); // polling starts by itself when the new item is pending
 */
export function usePolledProject(projectId, { load, errorMessage }) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(null);
  // Another project id (React Router keeps the page mounted when only the
  // `:projectId` param changes): drop the previous project and its error
  // before the first load of the new one, so the page shows its loading
  // state instead of the old project's items under the new URL (state
  // adjusted during render, so not even one frame shows the old project).
  const [shownId, setShownId] = useState(projectId);
  if (shownId !== projectId) {
    setShownId(projectId);
    setProject(null);
    setError(null);
    setLoading(Boolean(projectId));
  }
  // Ignore answers for a project the page no longer shows.
  const currentIdRef = useRef(projectId);
  currentIdRef.current = projectId;
  // The loader and the message helper may be new functions on every render.
  const loadRef = useRef(load);
  loadRef.current = load;
  const messageRef = useRef(errorMessage);
  messageRef.current = errorMessage;
  // Bumped by every read (reload or poll). Reads of the same project can
  // overlap — removing two items starts two reloads — and answer out of
  // order; only the latest read may publish, or an older snapshot would put
  // a deleted item's row back, and with no active item no poll corrects it.
  const readRef = useRef(0);
  const latest = (read, id) => readRef.current === read && currentIdRef.current === id;

  const reload = useCallback(async () => {
    if (!projectId) return null;
    const read = ++readRef.current;
    try {
      const loaded = await loadRef.current(projectId);
      if (!latest(read, projectId)) return null;
      setProject(loaded);
      setError(null);
      return loaded;
    } catch (err) {
      if (latest(read, projectId)) {
        setError({ message: messageRef.current(err), cause: err });
      }
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
      const read = ++readRef.current;
      try {
        const loaded = await loadRef.current(projectId);
        if (live && latest(read, projectId)) setProject(loaded);
      } catch (err) {
        // A failed poll keeps the items, but as a new array so this effect
        // re-arms and tries again after the interval.
        console.error('Failed to refresh project items:', err);
        if (live && latest(read, projectId)) {
          setProject(prev => (prev ? { ...prev, items: [...(prev.items || [])] } : prev));
        }
      }
    }, ITEM_POLL_INTERVAL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId, items]);

  return {
    project,
    setProject,
    loading,
    error: error?.message ?? null,
    errorObject: error?.cause ?? null,
    reload
  };
}

export default usePolledProject;
