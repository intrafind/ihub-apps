import React, { createContext, useContext, useEffect, useState } from 'react';
import { fetchPlatformConfig } from '../../api/api';

const PlatformConfigContext = createContext({
  platformConfig: null,
  isLoading: true,
  error: null
});

export const PlatformConfigProvider = ({ children }) => {
  const [platformConfig, setPlatformConfig] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        setIsLoading(true);
        const data = await fetchPlatformConfig();
        setPlatformConfig(data);
        setError(null);
      } catch (e) {
        console.error('Error fetching platform configuration:', e);
        setError('Failed to load platform configuration');
      } finally {
        setIsLoading(false);
      }
    };
    loadConfig();
  }, []);

  return (
    <PlatformConfigContext.Provider value={{ platformConfig, isLoading, error }}>
      {children}
    </PlatformConfigContext.Provider>
  );
};

export const usePlatformConfig = () => useContext(PlatformConfigContext);

export default PlatformConfigContext;
