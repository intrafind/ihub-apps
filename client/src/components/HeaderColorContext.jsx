import React, { createContext, useState, useContext, useEffect } from 'react';
import { useUIConfig } from './UIConfigContext';

// Default header color as a fallback if config is not loaded
const FALLBACK_COLOR = '#4f46e5'; // indigo-600

const HeaderColorContext = createContext({
  headerColor: FALLBACK_COLOR,
  setHeaderColor: () => {},
  resetHeaderColor: () => {}
});

export const HeaderColorProvider = ({ children }) => {
  const [headerColor, setHeaderColor] = useState(FALLBACK_COLOR);
  const [defaultHeaderColor, setDefaultHeaderColor] = useState(FALLBACK_COLOR);
  const { uiConfig } = useUIConfig();

  // Use the defaultColor from the shared UI config instead of fetching directly
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
    <HeaderColorContext.Provider value={{ headerColor, setHeaderColor, resetHeaderColor }}>
      {children}
    </HeaderColorContext.Provider>
  );
};

export const useHeaderColor = () => useContext(HeaderColorContext);

export default HeaderColorContext;