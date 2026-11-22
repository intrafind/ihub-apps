// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Suspense } from 'react';
import { useParams } from 'react-router-dom';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import NotFound from '../../../pages/error/NotFound';
import { useUserAppsConfig } from '../../../shared/hooks/useUserApps';

/** The path segment of the create page. `shared/appId.js` reserves it as an app ID. */
export const USER_APP_CREATE_SEGMENT = 'new';

function RouteLoading() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center">
      <LoadingSpinner />
    </div>
  );
}

/**
 * What a route of personal apps renders for the current viewer.
 *
 * - `create` sits on `apps/:appId` and decides for the segment `new`: the
 *   create page when the viewer may create personal apps, the chat otherwise.
 *   So an installation that has an app with the ID `new` keeps its chat at
 *   `/apps/new` for everyone who may not create personal apps, and with the
 *   feature off nothing is asked of the server at all.
 * - `edit` needs the feature and a signed-in viewer; whether this viewer may
 *   edit this app is the page's (and the server's) business.
 *
 * @param {Object} options
 * @param {'create'|'edit'} options.page
 * @param {string|undefined} options.appId - The `:appId` of the route.
 * @returns {{state: 'loading'|'page'|'fallback'}} `fallback`: the chat for
 *   `create`, the 404 page for `edit`.
 */
export function useUserAppsRouteState({ page, appId }) {
  const concerned = page === 'edit' || appId === USER_APP_CREATE_SEGMENT;
  // The configuration is only needed to decide about "New app".
  const { enabled, config, loading } = useUserAppsConfig({
    enabled: page === 'create' && concerned
  });
  if (!concerned) return { state: 'fallback' };
  if (loading) return { state: 'loading' };
  if (!enabled) return { state: 'fallback' };
  if (page === 'edit') return { state: 'page' };
  return { state: config?.canCreate === true ? 'page' : 'fallback' };
}

/**
 * Route element of the two pages of personal apps (`/apps/new`,
 * `/apps/:appId/edit`). The feature is decided inside the element, because
 * the platform configuration and the sign-in only resolve inside the
 * providers; a route registered conditionally in `App()` could never turn on.
 *
 * @param {Object} props
 * @param {'create'|'edit'} props.page
 * @param {React.ComponentType} props.component - The page, loaded lazily.
 * @param {React.ReactNode} [props.fallback] - What `create` renders when it is
 *   not the create page: the chat of the app with that ID.
 * @returns {JSX.Element}
 *
 * @example
 * <Route
 *   path="apps/:appId"
 *   element={
 *     <UserAppsRoute page="create" component={UserAppCreatePage} fallback={<SafeAppRouterWrapper />} />
 *   }
 * />
 */
function UserAppsRoute({ page, component: Component, fallback = null }) {
  const { appId } = useParams();
  const { state } = useUserAppsRouteState({ page, appId });
  if (state === 'loading') return <RouteLoading />;
  if (state === 'fallback') return page === 'create' ? fallback : <NotFound />;
  return (
    <Suspense fallback={<RouteLoading />}>
      <Component />
    </Suspense>
  );
}

export default UserAppsRoute;
