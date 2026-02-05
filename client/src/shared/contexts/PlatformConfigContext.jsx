import { createContext, useContext, useEffect, useState } from 'react';
import { fetchAuthStatus, fetchUIConfig } from '../../api/api';

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

      // Fetch both auth status and UI config in parallel
      const [authStatus, uiConfig] = await Promise.all([fetchAuthStatus(), fetchUIConfig()]);

      // Combine both configs into a single object that matches the previous platform config structure
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
