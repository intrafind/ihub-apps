// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * The platform config context object, on its own so that a component which only reads the
 * config (for example the EU AI Act master switch state) can import it without pulling the
 * provider, and with it the API client, into its module graph. `PlatformConfigContext.jsx`
 * provides it and re-exports both names.
 */
export const PlatformConfigContext = createContext({
  platformConfig: null,
  isLoading: true,
  error: null,
  refreshConfig: () => {}
});

/**
 * Hook to access platform configuration context.
 * Provides server configuration, authentication settings, and feature flags.
 * @returns {Object} Platform config context value
 * @returns {Object|null} returns.platformConfig - The platform configuration object
 * @returns {boolean} returns.isLoading - Whether config is still loading
 * @returns {string|null} returns.error - Error message if loading failed
 * @returns {Function} returns.refreshConfig - Function to reload configuration
 */
export function usePlatformConfig() {
  return useContext(PlatformConfigContext);
}
