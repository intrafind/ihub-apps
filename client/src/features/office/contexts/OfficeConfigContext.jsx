import { createContext, useContext } from 'react';

/**
 * Provides runtime configuration fetched from /api/integrations/office-addin/config.
 * Shape: { baseUrl: string, clientId: string, redirectUri: string }
 */
export const OfficeConfigContext = createContext(null);

export function useOfficeConfig() {
  // eslint-disable-next-line @eslint-react/no-use-context
  const ctx = useContext(OfficeConfigContext);
  if (!ctx) {
    throw new Error('useOfficeConfig must be used inside OfficeConfigProvider');
  }
  return ctx;
}
