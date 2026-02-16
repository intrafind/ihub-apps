import { createContext, useContext, useEffect, useState } from 'react';
import { fetchAuthStatus, fetchUIConfig, fetchPlatformConfig } from '../../api/api';

const PlatformConfigContext = createContext({
  platformConfig: null,
  isLoading: true,
  error: null,
  refreshConfig: () => {}
});

export const PlatformConfigProvider = ({ children }) => {
  const [platformConfig, setPlatformConfig] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadConfig = async () => {
    try {
      setIsLoading(true);

      // Fetch auth status, UI config, and platform config in parallel
      // On refresh (not initial load), skip cache to get fresh data
      const skipCache = platformConfig !== null;
      const [authStatus, uiConfig, platformCfg] = await Promise.all([
        fetchAuthStatus({ skipCache }),
        fetchUIConfig({ skipCache }),
        fetchPlatformConfig({ skipCache })
      ]);

      // Combine all configs into a single object that matches the previous platform config structure
      const combinedConfig = {
        // Auth-related fields from auth status
        auth: {
          mode: authStatus.authMode
        },
        anonymousAuth: authStatus.anonymousAuth,
        localAuth: authStatus.authMethods?.local,
        proxyAuth: authStatus.authMethods?.proxy,
        oidcAuth: authStatus.authMethods?.oidc,
        ldapAuth: authStatus.authMethods?.ldap,
        ntlmAuth: authStatus.authMethods?.ntlm,

        // UI-related fields from UI config
        admin: uiConfig.admin,
        version: uiConfig.version,
        computedRefreshSalt: uiConfig.computedRefreshSalt,
        defaultLanguage: uiConfig.defaultLanguage,

        // Platform features and settings
        features: platformCfg.features,
        // Build a boolean lookup map from the resolved features array
        featuresMap: Array.isArray(platformCfg.features)
          ? platformCfg.features.reduce((map, f) => {
              map[f.id] = f.enabled;
              return map;
            }, {})
          : platformCfg.features || {},

        // Additional auth status fields
        authenticated: authStatus.authenticated,
        user: authStatus.user,
        autoRedirect: authStatus.autoRedirect
      };

      setPlatformConfig(combinedConfig);
      setError(null);
    } catch (e) {
      console.error('Error fetching platform configuration:', e);
      setError('Failed to load platform configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const refreshConfig = () => {
    loadConfig();
  };

  useEffect(() => {
    loadConfig();
  }, []);

  return (
    <PlatformConfigContext.Provider value={{ platformConfig, isLoading, error, refreshConfig }}>
      {children}
    </PlatformConfigContext.Provider>
  );
};

/**
 * Hook to access platform configuration context.
 * Provides server configuration, authentication settings, and feature flags.
 * @returns {Object} Platform config context value
 * @returns {Object|null} returns.platformConfig - The platform configuration object
 * @returns {boolean} returns.isLoading - Whether config is still loading
 * @returns {string|null} returns.error - Error message if loading failed
 * @returns {Function} returns.refreshConfig - Function to reload configuration
 */
export const usePlatformConfig = () => useContext(PlatformConfigContext);

export default PlatformConfigContext;
