import React, { createContext, useState, useContext } from 'react';

// Default header color from the original design
const DEFAULT_HEADER_COLOR = '#4f46e5'; // indigo-600

const HeaderColorContext = createContext({
  headerColor: DEFAULT_HEADER_COLOR,
  setHeaderColor: () => {},
  resetHeaderColor: () => {}
});

export const HeaderColorProvider = ({ children }) => {
  const [headerColor, setHeaderColor] = useState(DEFAULT_HEADER_COLOR);

  const resetHeaderColor = () => {
    setHeaderColor(DEFAULT_HEADER_COLOR);
  };

  return (
    <HeaderColorContext.Provider value={{ headerColor, setHeaderColor, resetHeaderColor }}>
      {children}
    </HeaderColorContext.Provider>
  );
};

export const useHeaderColor = () => useContext(HeaderColorContext);

export default HeaderColorContext;