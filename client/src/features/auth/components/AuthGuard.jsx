import { useState } from 'react';
import { useAuth } from '../../../shared/contexts/AuthContext.jsx';
import LoginForm from './LoginForm.jsx';
import LoadingSpinner from '../../../shared/components/LoadingSpinner.jsx';

const AuthGuard = ({
  children,
  requireAuth = false,
  requireAdmin = false,
  fallbackComponent = null,
  showLogin = true
}) => {
  const { user, isAuthenticated, isLoading, authConfig } = useAuth();
  const [showLoginForm, setShowLoginForm] = useState(false);

  // Show loading spinner while checking auth
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Check if authentication is required
  if (requireAuth) {
    // If anonymous access is not allowed and user is not authenticated
    if (!authConfig.anonymousAuth?.enabled && !isAuthenticated) {
      if (showLogin && authConfig.authMethods.local.enabled) {
        if (showLoginForm) {
          return (
            <div className="flex items-center justify-center min-h-screen bg-gray-50">
              <LoginForm
                onSuccess={() => setShowLoginForm(false)}
                onCancel={() => setShowLoginForm(false)}
              />
            </div>
          );
        } else {
          return (
            <div className="flex items-center justify-center min-h-screen bg-gray-50">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  Authentication Required
                </h2>
                <p className="text-gray-600 mb-6">You need to sign in to access this resource.</p>
                <button
                  onClick={() => setShowLoginForm(true)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  Sign In
                </button>
              </div>
            </div>
          );
        }
      } else {
        return (
          fallbackComponent || (
            <div className="flex items-center justify-center min-h-screen bg-gray-50">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  Authentication Required
                </h2>
                <p className="text-gray-600">
                  Please contact your administrator to set up authentication.
                </p>
              </div>
            </div>
          )
        );
      }
    }
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
