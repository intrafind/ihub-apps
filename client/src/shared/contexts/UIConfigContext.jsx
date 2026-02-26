import { createContext, useState, useContext, useEffect } from 'react';
import { fetchUIConfig } from '../../api/api';
import { buildPath } from '../../utils/runtimeBasePath';

// Default header color as a fallback if config is not loaded
const FALLBACK_COLOR = '#4f46e5'; // indigo-600

// Consolidated context for UI configuration and header color
const UIConfigContext = createContext({
  uiConfig: null,
  isLoading: true,
  error: null,
  headerColor: FALLBACK_COLOR,
  setHeaderColor: () => {},
  resetHeaderColor: () => {},
  refreshUIConfig: () => {}
});

export const UIConfigProvider = ({ children }) => {
  const [uiConfig, setUiConfig] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Header color state (moved from HeaderColorContext)
  const [headerColor, setHeaderColor] = useState(FALLBACK_COLOR);
  const [defaultHeaderColor, setDefaultHeaderColor] = useState(FALLBACK_COLOR);

  // Fetch UI config function
  const fetchUiConfig = async () => {
    try {
      setIsLoading(true);
      // Using the exported fetchUIConfig function that uses apiClient
      const data = await fetchUIConfig();
      setUiConfig(data);
      setError(null);
    } catch (error) {
      console.error('Error fetching UI configuration:', error);
      setError('Failed to load UI configuration');
    } finally {
      setIsLoading(false);
    }
  };

  // Initial UI config fetch
  useEffect(() => {
    fetchUiConfig();
  }, []);

  // Set header color based on UI config
  useEffect(() => {
    if (uiConfig?.header?.defaultColor) {
      setDefaultHeaderColor(uiConfig.header.defaultColor);
      // Only set the header color if it hasn't been changed already
      if (headerColor === FALLBACK_COLOR) {
        setHeaderColor(uiConfig.header.defaultColor);
      }
    }
  }, [uiConfig, headerColor]);

  // Register or unregister service worker based on PWA config
  useEffect(() => {
    if (uiConfig === null) return;

    if (uiConfig?.pwa?.enabled) {
      import('../../services/swRegistration').then(({ registerServiceWorker }) => {
        registerServiceWorker();
      });
    } else {
      import('../../services/swRegistration').then(({ unregisterServiceWorker }) => {
        unregisterServiceWorker();
      });
    }
  }, [uiConfig?.pwa?.enabled]);

  // Inject PWA head tags (manifest link + theme-color) for dev and production
  useEffect(() => {
    if (uiConfig === null) return;

    if (uiConfig?.pwa?.enabled) {
      // Manifest link
      let manifest = document.getElementById('pwa-manifest-link');
      if (!manifest) {
        manifest = document.createElement('link');
        manifest.id = 'pwa-manifest-link';
        manifest.rel = 'manifest';
        manifest.href = buildPath('/manifest.json');
        document.head.appendChild(manifest);
      }

      // Theme color meta
      let themeColor = document.getElementById('pwa-theme-color');
      if (!themeColor) {
        themeColor = document.createElement('meta');
        themeColor.id = 'pwa-theme-color';
        themeColor.name = 'theme-color';
        document.head.appendChild(themeColor);
      }
      themeColor.content = uiConfig.pwa.themeColor || '#4f46e5';
    } else {
      document.getElementById('pwa-manifest-link')?.remove();
      document.getElementById('pwa-theme-color')?.remove();
    }

    return () => {
      document.getElementById('pwa-manifest-link')?.remove();
      document.getElementById('pwa-theme-color')?.remove();
    };
  }, [uiConfig?.pwa?.enabled, uiConfig?.pwa?.themeColor]);

  // Inject custom CSS from admin configuration
  useEffect(() => {
    const customCss = uiConfig?.customStyles?.css;

    // Remove existing custom styles if any
    const existingStyle = document.getElementById('admin-custom-styles');
    if (existingStyle) {
      existingStyle.remove();
    }

    // Inject new custom styles if available
    if (customCss) {
      const styleElement = document.createElement('style');
      styleElement.id = 'admin-custom-styles';
      styleElement.textContent = customCss;
      document.head.appendChild(styleElement);
    }
  }, [uiConfig?.customStyles?.css]);

  // Inject theme CSS link for CSS custom properties
  useEffect(() => {
    // Create or update the theme CSS link
    let themeLink = document.getElementById('ih-theme-css');
    if (!themeLink) {
      themeLink = document.createElement('link');
      themeLink.id = 'ih-theme-css';
      themeLink.rel = 'stylesheet';
      // Insert at the beginning of head to ensure Tailwind can override if needed
      const firstStylesheet = document.head.querySelector('link[rel="stylesheet"], style');
      if (firstStylesheet) {
        document.head.insertBefore(themeLink, firstStylesheet);
      } else {
        document.head.appendChild(themeLink);
      }
    }

    // Set href with cache-busting timestamp when config changes
    const timestamp = Date.now();
    themeLink.href = buildPath(`/api/theme.css?v=${timestamp}`);

    return () => {
      // Cleanup on unmount
      document.getElementById('ih-theme-css')?.remove();
    };
  }, [uiConfig?.theme, uiConfig?.customStyles?.css]);

  const resetHeaderColor = () => {
    setHeaderColor(defaultHeaderColor);
  };

  return (
    <UIConfigContext.Provider
      value={{
        uiConfig,
        isLoading,
        error,
        headerColor,
        setHeaderColor,
        resetHeaderColor,
        refreshUIConfig: fetchUiConfig
      }}
    >
      {children}
    </UIConfigContext.Provider>
  );
};

/**
 * Hook to access UI configuration context.
 * Provides UI customization settings, header color management, and branding options.
 * @returns {Object} UI config context value
 * @returns {Object|null} returns.uiConfig - The UI configuration object
 * @returns {boolean} returns.isLoading - Whether config is still loading
 * @returns {string|null} returns.error - Error message if loading failed
 * @returns {string} returns.headerColor - Current header color (hex)
 * @returns {Function} returns.setHeaderColor - Function to change header color
 * @returns {Function} returns.resetHeaderColor - Function to reset header to default
 * @returns {Function} returns.refreshUIConfig - Function to reload UI configuration
 */
export const useUIConfig = () => useContext(UIConfigContext);

export default UIConfigContext;
