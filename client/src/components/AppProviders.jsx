import React, { useEffect } from 'react';
import { UIConfigProvider } from './UIConfigContext';
import { PlatformConfigProvider } from './PlatformConfigContext';
import ErrorBoundaryFallback from './ErrorBoundary';
import { initializeForceRefresh } from '../utils/forceRefresh';

/**
 * Consolidates all application-level providers in a single component
 * for easier maintenance and clearer component hierarchy
 *
 * HeaderColorProvider has been consolidated into UIConfigProvider
 * for better performance and reduced component nesting
 */
const AppProviders = ({ children }) => {
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
      <PlatformConfigProvider>
        <UIConfigProvider>{children}</UIConfigProvider>
      </PlatformConfigProvider>
    </ErrorBoundaryFallback>
  );
};

export default AppProviders;
