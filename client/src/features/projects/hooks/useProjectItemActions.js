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
import { removeItemsInTurn, withoutItems } from '../utils/removeItems';

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
 * The item actions of the user project page: refresh (or retry),
 * edit (an item's name, "For the AI" setting and a link's reference), remove one and remove several. Each answers in
 * the shown project right away and reconciles with the server; a failure is reported in `error`.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {(updater: Function) => void} options.setProject - From `useProject`.
 * @param {() => Promise<Object|null>} options.reload - From `useProject`.
 * @returns {{busyItemId: string|null, error: string|null, clearError: () => void,
 *   refresh: (item: Object) => Promise<void>,
 *   update: (item: Object, changes: {name?: string, ref?: Object}) => Promise<Object|undefined>,
 *   editText: (item: Object, text: string) => Promise<Object|undefined>,
 *   remove: (item: Object) => Promise<void>,
 *   removeMany: (items: Object[]) => Promise<Set<string>>}}
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

  const refresh = useCallback(
    item =>
      run(item, async () => {
        const updated = await refreshProjectItem(projectId, item.id);
        if (updated) setProject(prev => replaceItem(prev, updated));
        await reload();
      }),
    [projectId, run, setProject, reload]
  );

  // The refresh TTL (#3536) and mode (#3622) of a file from a website or a
  // web page: `{refreshTtl?, refreshMode?}`; null goes back to the project's.
  // Throws like `editText`: the dialog shows the failure next to its form.
  const setRefreshTtl = useCallback(
    async (item, changes) => {
      setBusyItemId(item.id);
      try {
        const updated = await updateProjectItem(projectId, item.id, changes);
        // An item back on the project's setting comes without the key: the
        // merge in replaceItem must not keep the old value.
        if (updated) {
          setProject(prev =>
            replaceItem(prev, {
              ...updated,
              refreshTtl: updated.refreshTtl ?? undefined,
              refreshMode: updated.refreshMode ?? undefined
            })
          );
        }
        return true;
      } finally {
        setBusyItemId(null);
      }
    },
    [projectId, setProject]
  );

  // Throws like `editText`: the edit dialog shows the failure next to the form.
  // Changing what an item points at changes what the project holds, so the
  // usage counters are read again.
  const update = useCallback(
    async (item, changes) => {
      setBusyItemId(item.id);
      try {
        const updated = await updateProjectItem(projectId, item.id, changes);
        if (updated) setProject(prev => replaceItem(prev, updated));
        await reload();
        return updated;
      } finally {
        setBusyItemId(null);
      }
    },
    [projectId, setProject, reload]
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

  /**
   * Remove several items, one request each and one after the other, so each
   * is checked and recorded like a single removal. An item that is already
   * gone counts as removed; one that could not be removed stays, and `error`
   * says how many and why the first did not go.
   *
   * @param {Object[]} items
   * @returns {Promise<Set<string>>} The ids of the items that are gone.
   */
  const removeMany = useCallback(
    async items => {
      setError(null);
      const { removed, failed } = await removeItemsInTurn(
        items,
        item => deleteProjectItem(projectId, item.id),
        {
          messageOf: err => projectErrorMessage(err, t),
          onItem: item => setBusyItemId(item?.id ?? null)
        }
      );
      setProject(prev => withoutItems(prev, removed));
      if (failed.length > 0) {
        setError(
          t(
            'projects.items.removeSelectedFailed',
            '{{count}} documents could not be removed: {{reason}}',
            { count: failed.length, reason: failed[0] }
          )
        );
      }
      // The usage counters change with the items.
      await reload();
      return removed;
    },
    [projectId, setProject, reload, t]
  );

  return {
    busyItemId,
    error,
    clearError: () => setError(null),
    refresh,
    setRefreshTtl,
    update,
    editText,
    remove,
    removeMany
  };
}

export default useProjectItemActions;
