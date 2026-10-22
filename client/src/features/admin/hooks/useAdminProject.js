// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fetchAdminProject, getAdminApiErrorMessage } from '../../../api/adminApi';
import { usePolledProject } from '../../projects/hooks/usePolledProject';

/**
 * Loads one admin project and keeps its items current while any item is
 * being extracted (see {@link usePolledProject}, which the user project page
 * shares).
 *
 * @param {string|null} projectId - `null` (a project being created) loads nothing.
 * @returns {ReturnType<typeof usePolledProject>}
 *
 * @example
 * const { project, reload } = useAdminProject(id);
 * await addAdminProjectItem(id, body);
 * await reload(); // polling starts by itself when the new item is pending
 */
export function useAdminProject(projectId) {
  return usePolledProject(projectId, {
    load: fetchAdminProject,
    errorMessage: getAdminApiErrorMessage
  });
}

export default useAdminProject;
