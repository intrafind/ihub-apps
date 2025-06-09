import React from "react";
import { UIConfigProvider } from "./UIConfigContext";
import ErrorBoundaryFallback from "./ErrorBoundary";

/**
 * Consolidates all application-level providers in a single component
 * for easier maintenance and clearer component hierarchy
 *
 * HeaderColorProvider has been consolidated into UIConfigProvider
 * for better performance and reduced component nesting
 */
const AppProviders = ({ children }) => {
  return (
    <ErrorBoundaryFallback>
      <UIConfigProvider>{children}</UIConfigProvider>
    </ErrorBoundaryFallback>
  );
};

export default AppProviders;
