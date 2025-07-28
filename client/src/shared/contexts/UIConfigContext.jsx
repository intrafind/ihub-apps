import { createContext, useState, useContext, useEffect } from 'react';
import { fetchUIConfig } from '../../api/api';

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

export const useUIConfig = () => useContext(UIConfigContext);

export default UIConfigContext;
