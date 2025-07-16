import { withErrorBoundary } from './ErrorBoundary';

export const withSafeRoute = Component => {
  return withErrorBoundary(Component);
};
