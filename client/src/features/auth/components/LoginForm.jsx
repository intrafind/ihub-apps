import React, { useState } from 'react';
import { useAuth } from '../../../shared/contexts/AuthContext.jsx';
import LoadingSpinner from '../../../shared/components/LoadingSpinner.jsx';

const LoginForm = ({ onSuccess, onCancel }) => {
  const { login, loginWithOidc, isLoading, error, authConfig } = useAuth();
  const [formData, setFormData] = useState({
    username: '',
    password: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.username || !formData.password) {
      return;
    }

    setIsSubmitting(true);
    
    try {
      const result = await login(formData.username, formData.password);
      
      if (result.success) {
        onSuccess?.();
      }
    } catch (error) {
      console.error('Login form error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOidcLogin = (providerName) => {
    loginWithOidc(providerName);
  };

  // Check if OIDC is enabled and has providers
  const oidcProviders = authConfig?.authMethods?.oidc?.providers || [];
  const hasOidcProviders = authConfig?.authMethods?.oidc?.enabled && oidcProviders.length > 0;
  const hasLocalAuth = authConfig?.authMethods?.local?.enabled;

  // Provider icon mapping
  const getProviderIcon = (providerName) => {
    switch (providerName) {
      case 'google':
        return '🔍'; // Google
      case 'microsoft':
        return '🏢'; // Microsoft
      case 'auth0':
        return '🔐'; // Auth0
      default:
        return '🔑'; // Generic key
    }
  };

  const isFormLoading = isLoading || isSubmitting;

  return (
    <div className="max-w-md mx-auto bg-white shadow-lg rounded-lg p-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">
        Sign In
      </h2>
      
      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* OIDC Providers */}
      {hasOidcProviders && (
        <div className="mb-6">
          <div className="text-sm text-gray-600 text-center mb-3">Sign in with:</div>
          <div className="space-y-2">
            {oidcProviders.map((provider) => (
              <button
                key={provider.name}
                type="button"
                onClick={() => handleOidcLogin(provider.name)}
                disabled={isFormLoading}
                className="w-full flex items-center justify-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
              >
                <span className="mr-2">{getProviderIcon(provider.name)}</span>
                {provider.displayName || provider.name}
              </button>
            ))}
          </div>
          
          {hasLocalAuth && (
            <div className="my-4 flex items-center">
              <div className="flex-grow border-t border-gray-300"></div>
              <span className="px-3 text-sm text-gray-500">or</span>
              <div className="flex-grow border-t border-gray-300"></div>
            </div>
          )}
        </div>
      )}
      
      {/* Local Auth Form - only show if local auth is enabled */}
      {hasLocalAuth && (
        <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
            Username or Email
          </label>
          <input
            type="text"
            id="username"
            name="username"
            value={formData.username}
            onChange={handleInputChange}
            required
            disabled={isFormLoading}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            placeholder="Enter your username or email"
          />
        </div>
        
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
            Password
          </label>
          <input
            type="password"
            id="password"
            name="password"
            value={formData.password}
            onChange={handleInputChange}
            required
            disabled={isFormLoading}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            placeholder="Enter your password"
          />
        </div>
        
        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            disabled={isFormLoading || !formData.username || !formData.password}
            className="flex-1 flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {isFormLoading ? (
              <>
                <LoadingSpinner size="sm" className="mr-2" />
                Signing In...
              </>
            ) : (
              'Sign In'
            )}
          </button>
          
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isFormLoading}
              className="flex-1 py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          )}
        </div>
        </form>
      )}

      {/* Show demo accounts only if local auth is enabled */}
      {hasLocalAuth && (
        <div className="mt-6 text-xs text-gray-500 text-center">
          <p>Demo accounts:</p>
          <p>Admin: admin / password123</p>
          <p>User: user / password123</p>
        </div>
      )}

      {/* Show message if no auth methods are available */}
      {!hasLocalAuth && !hasOidcProviders && (
        <div className="text-center text-gray-500">
          <p>No authentication methods are currently enabled.</p>
          <p className="text-sm mt-2">Please contact your administrator.</p>
        </div>
      )}
    </div>
  );
};

export default LoginForm;