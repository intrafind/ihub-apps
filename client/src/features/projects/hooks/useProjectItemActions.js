// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteProjectItem,
  refreshProjectItem,
  updateProjectItem,
  updateProjectItemText
} from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';

/**
 * Replace one item of a project in place, keeping the others.
 *
 * @param {Object|null} project
 * @param {Object} item - The updated item.
 * @returns {Object|null}
 */
export function replaceItem(project, item) {
  if (!project || !item?.id) return project;
  return {
    ...project,
    items: (project.items || []).map(entry =>
      entry.id === item.id ? { ...entry, ...item } : entry
    )
  };
}

/**
 * The item actions of the user project page: pin, refresh (or retry),
 * rename and remove. Each answers in the shown project right away and
 * reconciles with the server; a failure is reported in `error`.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {(updater: Function) => void} options.setProject - From `useProject`.
 * @param {() => Promise<Object|null>} options.reload - From `useProject`.
 * @returns {{busyItemId: string|null, error: string|null, clearError: () => void,
 *   togglePinned: (item: Object) => Promise<void>, refresh: (item: Object) => Promise<void>,
 *   rename: (item: Object, name: string) => Promise<boolean>,
 *   editText: (item: Object, text: string) => Promise<Object|undefined>,
 *   remove: (item: Object) => Promise<void>}}
 */
export function useProjectItemActions({ projectId, setProject, reload }) {
  const { t } = useTranslation();
  const [busyItemId, setBusyItemId] = useState(null);
  const [error, setError] = useState(null);

  const run = useCallback(
    async (item, action) => {
      setBusyItemId(item.id);
      setError(null);
      try {
        await action();
        return true;
      } catch (err) {
        setError(projectErrorMessage(err, t));
        return false;
      } finally {
        setBusyItemId(null);
      }
    },
    [t]
  );

  const togglePinned = useCallback(
    item =>
      run(item, async () => {
        const updated = await updateProjectItem(projectId, item.id, { pinned: !item.pinned });
        setProject(prev => replaceItem(prev, updated || { ...item, pinned: !item.pinned }));
      }),
    [projectId, run, setProject]
  );

  const refresh = useCallback(
    item =>
      run(item, async () => {
        const updated = await refreshProjectItem(projectId, item.id);
        if (updated) setProject(prev => replaceItem(prev, updated));
        await reload();
      }),
    [projectId, run, setProject, reload]
  );

  const rename = useCallback(
    (item, name) =>
      run(item, async () => {
        const updated = await updateProjectItem(projectId, item.id, { name });
        setProject(prev => replaceItem(prev, updated || { ...item, name }));
      }),
    [projectId, run, setProject]
  );

  // Unlike the others, this one throws: the text dialog shows the failure
  // next to the text being edited, not in the page's banner.
  const editText = useCallback(
    async (item, text) => {
      setBusyItemId(item.id);
      try {
        const updated = await updateProjectItemText(projectId, item.id, text);
        if (updated) setProject(prev => replaceItem(prev, updated));
        // The usage counters change with the text.
        await reload();
        return updated;
      } finally {
        setBusyItemId(null);
      }
    },
    [projectId, setProject, reload]
  );

  const remove = useCallback(
    item =>
      run(item, async () => {
        await deleteProjectItem(projectId, item.id);
        setProject(prev =>
          prev ? { ...prev, items: (prev.items || []).filter(entry => entry.id !== item.id) } : prev
        );
        // The usage counters change with the item.
        await reload();
      }),
    [projectId, run, setProject, reload]
  );

  return {
    busyItemId,
    error,
    clearError: () => setError(null),
    togglePinned,
    refresh,
    rename,
    editText,
    remove
  };
}

export default useProjectItemActions;
