import { useEffect } from 'react';
import { useAuth } from '../../../shared/contexts/AuthContext.jsx';
import LoadingSpinner from '../../../shared/components/LoadingSpinner.jsx';

const AuthGuard = ({
  children,
  requireAuth = false,
  requireAdmin = false,
  fallbackComponent = null
}) => {
  const { user, isAuthenticated, isLoading, authConfig } = useAuth();

  // If auth is required and user is not authenticated, delegate to the auth gate
  useEffect(() => {
    if (
      requireAuth &&
      !isLoading &&
      !isAuthenticated &&
      !authConfig.anonymousAuth?.enabled &&
      window.__authGate &&
      !window.__authGate.isVisible()
    ) {
      window.__authGate.show({ overlay: true });
    }
  }, [requireAuth, isLoading, isAuthenticated, authConfig]);

  // Show loading spinner while checking auth
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Check if authentication is required
  if (requireAuth && !authConfig.anonymousAuth?.enabled && !isAuthenticated) {
    // Auth gate is handling login — render nothing (or fallback) while waiting
    return fallbackComponent || null;
  }

  // Check admin access requirement
  if (requireAdmin && !user?.isAdmin && !user?.permissions?.adminAccess) {
    return (
      fallbackComponent || (
        <div className="flex items-center justify-center min-h-screen bg-gray-50">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Admin Access Required</h2>
            <p className="text-gray-600">You don't have permission to access this resource.</p>
          </div>
        </div>
      )
    );
  }

  // All checks passed, render children
  return children;
};

export default AuthGuard;
