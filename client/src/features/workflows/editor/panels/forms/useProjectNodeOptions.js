// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { fetchAdminProjectKinds, fetchAdminProjects } from '../../../../../api/adminApi';
import { ITEM_DIALOG_TABS } from '../../../../projects/utils/projectItems';

/**
 * Data the project step forms of the workflow editor (#1036, slice 6) load
 * from the admin API: the admin projects to pick from and the item kinds a
 * `project-items` filter can select. Both are hints for the author: a
 * failure never blocks the form, the project field then takes a typed id or
 * reference and the kinds fall back to the built-in list.
 *
 * @module features/workflows/editor/panels/forms/useProjectNodeOptions
 */

/** Item kinds of the "Add item" dialog, used when the server's list cannot be loaded. */
export const FALLBACK_ITEM_KINDS = Object.freeze([
  ...new Set(ITEM_DIALOG_TABS.map(tab => tab.kind))
]);

/**
 * Whether an admin API error says the projects feature is switched off.
 *
 * @param {*} err
 * @returns {boolean}
 */
function isFeatureDisabled(err) {
  return err?.response?.status === 403 && err.response?.data?.code === 'FEATURE_DISABLED';
}

/**
 * The admin projects an author can pick for a project step
 * (`GET /api/admin/projects`, the same list the admin `ProjectPicker` uses).
 *
 * @returns {{projects: Array<Object>, loading: boolean, error: boolean,
 *   featureDisabled: boolean, reload: () => Promise<void>}}
 */
export function useAdminProjectOptions() {
  const [state, setState] = useState({
    projects: [],
    loading: true,
    error: false,
    featureDisabled: false
  });

  const reload = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: false }));
    try {
      const projects = await fetchAdminProjects();
      setState({ projects, loading: false, error: false, featureDisabled: false });
    } catch (err) {
      setState({
        projects: [],
        loading: false,
        error: !isFeatureDisabled(err),
        featureDisabled: isFeatureDisabled(err)
      });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * The item kinds a `project-items` filter offers: the server's kinds
 * (`GET /api/admin/projects/_kinds`, with their localized names), else the
 * built-in kind ids.
 *
 * @returns {{kinds: Array<{id: string, name?: Object|string, enabled?: boolean}>, loading: boolean}}
 */
export function useProjectKindOptions() {
  const [state, setState] = useState({ kinds: [], loading: true });

  useEffect(() => {
    let mounted = true;
    fetchAdminProjectKinds()
      .then(kinds => {
        if (!mounted) return;
        const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : null;
        setState({
          kinds: list || FALLBACK_ITEM_KINDS.map(id => ({ id })),
          loading: false
        });
      })
      .catch(err => {
        console.error('Failed to load project item kinds:', err);
        if (mounted) setState({ kinds: FALLBACK_ITEM_KINDS.map(id => ({ id })), loading: false });
      });
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
