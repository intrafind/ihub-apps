import { useEffect } from 'react';
import { UIConfigProvider } from '../../../shared/contexts/UIConfigContext';
import { PlatformConfigProvider } from '../../../shared/contexts/PlatformConfigContext';
import ErrorBoundaryFallback from '../../../shared/components/ErrorBoundary';
import { initializeForceRefresh } from '../../../utils/forceRefresh';
import { NetworkStatusProvider } from '../../../shared/hooks/useNetworkStatus';
import OfflineOverlay from '../../../shared/components/OfflineOverlay';

/**
 * Consolidates all application-level providers in a single component
 * for easier maintenance and clearer component hierarchy
 *
 * HeaderColorProvider has been consolidated into UIConfigProvider
 * for better performance and reduced component nesting
 */
function AppProviders({ children }) {
  // Initialize force refresh check early in the application startup
  useEffect(() => {
    const checkForceRefresh = async () => {
      try {
        await initializeForceRefresh();
      } catch (error) {
        console.error('Error initializing force refresh:', error);
        // Continue with normal app startup even if force refresh fails
      }
    };

    checkForceRefresh();
  }, []);

  return (
    <ErrorBoundaryFallback>
      <NetworkStatusProvider>
        <OfflineOverlay />
        <PlatformConfigProvider>
          <UIConfigProvider>{children}</UIConfigProvider>
        </PlatformConfigProvider>
      </NetworkStatusProvider>
    </ErrorBoundaryFallback>
  );
}

export default AppProviders;
