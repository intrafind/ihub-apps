import React, { createContext, useState, useContext, useEffect } from 'react';

// Context for storing and sharing UI configuration across components
const UIConfigContext = createContext({
  uiConfig: null,
  isLoading: true,
  error: null
});

export const UIConfigProvider = ({ children }) => {
  const [uiConfig, setUiConfig] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchUiConfig = async () => {
      try {
        setIsLoading(true);
        const response = await fetch('/api/ui');
        const data = await response.json();
        setUiConfig(data);
        setError(null);
      } catch (error) {
        console.error('Error fetching UI configuration:', error);
        setError('Failed to load UI configuration');
      } finally {
        setIsLoading(false);
      }
    };

    fetchUiConfig();
  }, []);

  return (
    <UIConfigContext.Provider value={{ uiConfig, isLoading, error }}>
      {children}
    </UIConfigContext.Provider>
  );
};

export const useUIConfig = () => useContext(UIConfigContext);

export default UIConfigContext;