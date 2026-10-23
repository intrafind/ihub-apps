// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useOptionalAuth } from '../../../shared/contexts/authContextValue';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { fetchProject, fetchProjects, fetchProjectsConfig } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { createViewerStore } from './projectStore';
import { usePolledProject } from './usePolledProject';

/**
 * Hooks of the user projects UI (#1036). Every part of it is gated the same
 * way: the platform config's `projects` block says whether projects and user
 * projects are on (flags plus storage), and the viewer has to be signed in
 * (an anonymous caller never sees a project). Nothing is requested while the
 * gate is closed.
 *
 * @module features/projects/hooks/useProjects
 */

const configStore = createViewerStore(fetchProjectsConfig);
const listStore = createViewerStore(() => fetchProjects({ scope: 'all' }), { ttlMs: 15_000 });

/** Drop the cached project list (after a create, delete, transfer or leave). */
export const invalidateProjectsList = () => listStore.invalidate();

/** Drop the cached projects configuration (its `used` count changes on create and delete). */
export const invalidateProjectsConfig = () => configStore.invalidate();

/**
 * The viewer, and whether they may hold projects at all.
 *
 * @returns {{loading: boolean, signedIn: boolean, userId: string|null, key: string|null}}
 */
function useViewer() {
  const auth = useOptionalAuth() || {};
  const loading = auth.isLoading === true;
  const userId = auth.user?.id ? String(auth.user.id) : null;
  const signedIn = auth.isAuthenticated === true && Boolean(userId) && userId !== 'anonymous';
  return {
    loading,
    signedIn,
    userId,
    key: loading ? null : `${signedIn ? 'auth' : 'anon'}:${userId ?? ''}`
  };
}

/**
 * Whether projects are available to the current viewer.
 *
 * @returns {{loading: boolean, projectsEnabled: boolean, userProjectsEnabled: boolean,
 *   userId: string|null}}
 */
export function useProjectsAvailability() {
  const { platformConfig, isLoading } = usePlatformConfig() || {};
  const viewer = useViewer();
  const block = platformConfig?.projects || {};
  const projectsEnabled = !isLoading && viewer.signedIn && block.enabled === true;
  return {
    loading: isLoading === true || viewer.loading,
    projectsEnabled,
    userProjectsEnabled: projectsEnabled && block.userProjects === true,
    userId: viewer.userId
  };
}

/**
 * What the `/projects` routes render: wait until the platform config and the
 * auth status landed, so a signed-in user is not shown a 404 first.
 *
 * @returns {'loading'|'unavailable'|'ready'}
 */
export function useProjectsRouteState() {
  const { loading, userProjectsEnabled } = useProjectsAvailability();
  if (loading) return 'loading';
  return userProjectsEnabled ? 'ready' : 'unavailable';
}

/**
 * The projects configuration of the viewer (`GET /api/projects/_config`):
 * whether they may create and share, the limits, the item kinds and the
 * upload settings. Loaded once per viewer and shared.
 *
 * @returns {{config: Object|null, loading: boolean, error: Error|null, reload: () => Promise<Object>}}
 */
export function useProjectsConfig() {
  const { userProjectsEnabled } = useProjectsAvailability();
  const { key } = useViewer();
  const { data, loading, error, reload } = configStore.use(key, userProjectsEnabled);
  return { config: data || null, loading, error, reload };
}

/**
 * The projects the viewer may use (owned, shared with them, and admin
 * projects of their apps). Shared between the project list, the chat
 * history badges.
 *
 * @param {{enabled?: boolean}} [options] - `enabled: false` loads nothing (a caller
 *   that only sometimes needs the list).
 * @returns {{projects: Array<Object>, loading: boolean, error: Error|null, reload: () => Promise<Array>}}
 */
export function useMyProjects({ enabled = true } = {}) {
  const { userProjectsEnabled } = useProjectsAvailability();
  const { key } = useViewer();
  const { data, loading, error, reload } = listStore.use(key, userProjectsEnabled && enabled);
  return { projects: Array.isArray(data) ? data : [], loading, error, reload };
}

/**
 * The projects the viewer may use wherever a project is picked outside the
 * project pages (#1036 slice 6: the workflow run dialog's input of type
 * `project`). Unlike {@link useMyProjects} it is open whenever projects are
 * on, user projects or not: with user projects off the server lists the admin
 * projects of the viewer's apps. Shares the cached list with the other
 * consumers.
 *
 * @returns {{projects: Array<Object>, loading: boolean, error: Error|null,
 *   available: boolean, reload: () => Promise<Array>}}
 */
export function useUsableProjects() {
  const { projectsEnabled, loading: gateLoading } = useProjectsAvailability();
  const { key } = useViewer();
  const { data, loading, error, reload } = listStore.use(key, projectsEnabled);
  return {
    projects: Array.isArray(data) ? data : [],
    loading: gateLoading || loading,
    error,
    available: projectsEnabled,
    reload
  };
}

/**
 * One project with its items, re-read while an item is being extracted.
 *
 * @param {string|null} projectId
 * @returns {ReturnType<typeof usePolledProject>}
 */
export function useProject(projectId) {
  const { t } = useTranslation();
  const errorMessage = useCallback(err => projectErrorMessage(err, t), [t]);
  return usePolledProject(projectId, { load: fetchProject, errorMessage });
}
