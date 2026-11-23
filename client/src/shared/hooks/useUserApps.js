// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUserAppsConfig } from '../../api';
import { useOptionalAuth, useViewerKey } from '../contexts/authContextValue';
import { usePlatformConfig } from '../contexts/platformConfigContextValue';
import { createViewerStore } from '../../features/projects/hooks/projectStore';
import { FeatureFlags } from '../../../../shared/featureFlags.js';

/**
 * Hooks of personal apps. Every part of the UI is gated the same way: the
 * feature `userApps` has to be on and the viewer signed in (an anonymous
 * caller holds no apps). While the gate is closed nothing is requested, so
 * with the feature off the client behaves as it did before personal apps.
 *
 * @module shared/hooks/useUserApps
 */

/**
 * Whether personal apps are on for the current viewer.
 *
 * @returns {{loading: boolean, enabled: boolean, userId: string|null}}
 *   `loading`: the platform configuration or the sign-in has not landed yet.
 */
export function useUserAppsAvailability() {
  const { platformConfig, isLoading } = usePlatformConfig() || {};
  const auth = useOptionalAuth() || {};
  const authLoading = auth.isLoading === true;
  const userId = auth.user?.id ? String(auth.user.id) : null;
  const signedIn = auth.isAuthenticated === true && Boolean(userId) && userId !== 'anonymous';
  const featureOn = useMemo(
    () => Boolean(platformConfig) && new FeatureFlags(platformConfig).isEnabled('userApps', false),
    [platformConfig]
  );
  return {
    loading: isLoading === true || authLoading,
    enabled: !isLoading && !authLoading && signedIn && featureOn,
    userId
  };
}

// The language of the labels in the answer (the names of connected systems). The store's key
// holds it too, so a change of language loads the configuration again.
let configLanguage;
const configStore = createViewerStore(() => fetchUserAppsConfig({ language: configLanguage }));

/** Drop the cached configuration (its `used` count changes on create, duplicate and delete). */
export const invalidateUserAppsConfig = () => configStore.invalidate();

/**
 * What personal apps offer the viewer (`GET /api/apps/_config`): `canCreate`,
 * `canShare`, `canPublish`, the limit and the capabilities. Loaded once per
 * viewer and shared; not requested while the feature is off.
 *
 * @param {{enabled?: boolean}} [options] - `enabled: false` loads nothing (a
 *   caller that only sometimes needs it).
 * @returns {{enabled: boolean, config: Object|null, loading: boolean, error: Error|null,
 *   reload: () => Promise<Object>}} `enabled`: personal apps are on for the viewer.
 *
 * @example
 * const { enabled, config } = useUserAppsConfig();
 * const showNewApp = enabled && config?.canCreate === true;
 */
export function useUserAppsConfig({ enabled: wanted = true } = {}) {
  const availability = useUserAppsAvailability();
  const viewerKey = useViewerKey();
  const { i18n } = useTranslation();
  const language = String(i18n?.language || '').split('-')[0] || undefined;
  configLanguage = language;
  const key = `${viewerKey}|${language || ''}`;
  const active = availability.enabled && wanted;
  const { data, loading, error, reload } = configStore.use(key, active);
  return {
    enabled: availability.enabled,
    config: data || null,
    // Active without an answer and without an error is still loading: the store starts its
    // request in an effect, one render after the gate opened.
    loading: availability.loading || (active && (loading || (data === undefined && !error))),
    error,
    reload
  };
}
