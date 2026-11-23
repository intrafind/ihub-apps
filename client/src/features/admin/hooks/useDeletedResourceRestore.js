// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * Whether the page of an item that is not there (404) can offer to restore it
 * from the change history. A model or app delete keeps a snapshot of what was
 * deleted, and the delete dialog tells the admin to open the item's page again
 * to restore it; this hook finds out whether there is anything to restore.
 *
 * Only a full admin may read the history: for anyone else, and when the history
 * cannot be read, nothing is offered and the page keeps its "Back to …" action.
 *
 * @param {Object} options
 * @param {'model'|'app'} options.resource - Resource type of the change history.
 * @param {string} options.resourceId
 * @param {boolean} options.notFound - The item's load answered 404.
 * @returns {{ restorable: boolean }}
 *
 * @example
 * const { restorable } = useDeletedResourceRestore({ resource: 'model', resourceId: id,
 *   notFound: loadError?.status === 404 });
 */
export function useDeletedResourceRestore({ resource, resourceId, notFound }) {
  // The item whose history was found, so an answer for another item never counts.
  const [restorableKey, setRestorableKey] = useState(null);
  const key = `${resource}/${resourceId}`;

  useEffect(() => {
    if (!notFound || !resourceId) return undefined;
    let current = true;
    makeAdminApiCall(
      `/admin/changes/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}`
    )
      .then(response => {
        const snapshots = response?.data;
        if (current && Array.isArray(snapshots) && snapshots.length > 0) setRestorableKey(key);
      })
      .catch(() => {
        // No history to offer (not permitted, or unreadable): the page keeps its back action.
      });
    return () => {
      current = false;
    };
  }, [resource, resourceId, notFound, key]);

  return { restorable: Boolean(notFound) && restorableKey === key };
}

export default useDeletedResourceRestore;
