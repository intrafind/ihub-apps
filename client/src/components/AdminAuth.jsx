import React, { useState } from 'react';
import { useAdminAuth } from '../hooks/useAdminAuth';
import Icon from './Icon';

const AdminAuth = ({ children }) => {
  const { isAuthenticated, authRequired, isLoading, login, logout } = useAdminAuth();
  const [adminSecret, setAdminSecret] = useState('');
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);
    
    const result = await login(adminSecret);
    
    if (!result.success) {
      setError(result.error);
      setAdminSecret('');
    }
    
    setIsLoggingIn(false);
  };

  const handleLogout = () => {
    logout();
    setAdminSecret('');
    setError('');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Checking authentication...</p>
        </div>
      </div>
    );
  }

  // If authentication is not required, or user is authenticated, show children
  if (!authRequired || isAuthenticated) {
    return (
      <div>
        {/* Admin header with logout if authenticated */}
        {authRequired && isAuthenticated && (
          <div className="bg-green-50 border-b border-green-200 px-4 py-2">
            <div className="flex justify-between items-center max-w-7xl mx-auto">
              <div className="flex items-center space-x-2">
                <Icon name="shield-check" className="h-4 w-4 text-green-600" />
                <span className="text-sm text-green-700">Admin authenticated</span>
              </div>
              <button
                onClick={handleLogout}
                className="text-sm text-green-600 hover:text-green-800 font-medium"
              >
                Logout
              </button>
            </div>
          </div>
        )}
        {children}
      </div>
    );
  }

  // Show login form
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-indigo-100">
            <Icon name="shield-check" className="h-6 w-6 text-indigo-600" />
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Admin Authentication
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Enter your admin secret to access the admin panel
          </p>
        </div>
        
        <form className="mt-8 space-y-6" onSubmit={handleLogin}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="admin-secret" className="sr-only">
                Admin Secret
              </label>
              <input
                id="admin-secret"
                name="admin-secret"
                type="password"
                required
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Admin secret"
                value={adminSecret}
                onChange={(e) => setAdminSecret(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              </div>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={isLoggingIn}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoggingIn ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Authenticating...
                </>
              ) : (
                <>
                  <Icon name="shield-check" className="h-4 w-4 mr-2" />
                  Authenticate
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AdminAuth;