import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../shared/contexts/AuthContext.jsx';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext.jsx';
import LoadingSpinner from '../../../shared/components/LoadingSpinner.jsx';

const LoginForm = ({ onSuccess, onCancel }) => {
  const { t } = useTranslation();
  const { login, loginWithOidc, isLoading, error, authConfig } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    provider: '' // For LDAP provider selection
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleInputChange = e => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async e => {
    e.preventDefault();

    if (!formData.username || !formData.password) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Pass provider to login if LDAP is being used
      const result = await login(formData.username, formData.password, formData.provider);

      if (result.success) {
        onSuccess?.();
      }
    } catch (error) {
      console.error('Login form error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOidcLogin = providerName => {
    loginWithOidc(providerName);
  };

  const handleNtlmLogin = () => {
    // Store current URL for return after NTLM authentication
    const returnUrl = window.location.href;

    // Redirect to NTLM login endpoint which will trigger NTLM authentication
    const ntlmLoginUrl = `/api/auth/ntlm/login?returnUrl=${encodeURIComponent(returnUrl)}`;
    window.location.href = ntlmLoginUrl;
  };

  // Check if OIDC is enabled and has providers
  const oidcProviders = authConfig?.authMethods?.oidc?.providers || [];
  const hasOidcProviders = authConfig?.authMethods?.oidc?.enabled && oidcProviders.length > 0;
  const hasLocalAuth = authConfig?.authMethods?.local?.enabled;

  // Check if LDAP is enabled
  const ldapProviders = authConfig?.authMethods?.ldap?.providers || [];
  const hasLdapAuth = authConfig?.authMethods?.ldap?.enabled;

  // Check if NTLM is enabled
  const hasNtlmAuth = authConfig?.authMethods?.ntlm?.enabled;
  const ntlmDomain = authConfig?.authMethods?.ntlm?.domain;

  // Show username/password form if either local or LDAP auth is enabled
  const hasUsernamePasswordAuth = hasLocalAuth || hasLdapAuth;
  const showDemoAccounts = platformConfig?.localAuth?.showDemoAccounts === true;

  // Count total number of auth methods for proper separator logic
  const totalAuthMethods =
    (hasOidcProviders ? 1 : 0) + (hasNtlmAuth ? 1 : 0) + (hasUsernamePasswordAuth ? 1 : 0);

  // Provider icon mapping
  const getProviderIcon = providerName => {
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
        {t('errors.signIn', 'Sign In')}
      </h2>

      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* OIDC Providers */}
      {hasOidcProviders && (
        <div className="mb-6">
          <div className="text-sm text-gray-600 text-center mb-3">
            {t('auth.login.signInWith', 'Sign in with:')}
          </div>
          <div className="space-y-2">
            {oidcProviders.map(provider => (
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

          {/* Show separator only if there are other auth methods */}
          {totalAuthMethods > 1 && (
            <div className="my-4 flex items-center">
              <div className="flex-grow border-t border-gray-300"></div>
              <span className="px-3 text-sm text-gray-500">{t('auth.login.or', 'or')}</span>
              <div className="flex-grow border-t border-gray-300"></div>
            </div>
          )}
        </div>
      )}

      {/* NTLM Provider */}
      {hasNtlmAuth && (
        <div className="mb-6">
          {!hasOidcProviders && totalAuthMethods > 1 && (
            <div className="text-sm text-gray-600 text-center mb-3">
              {t('auth.login.signInWith', 'Sign in with:')}
            </div>
          )}
          <button
            type="button"
            onClick={handleNtlmLogin}
            disabled={isFormLoading}
            className="w-full flex items-center justify-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          >
            <span className="mr-2">🔐</span>
            {t('auth.login.windowsAuth', 'Windows Authentication')}
            {ntlmDomain && <span className="ml-1 text-xs text-gray-500">({ntlmDomain})</span>}
          </button>

          {/* Show separator only if there are more auth methods after NTLM */}
          {hasUsernamePasswordAuth && (
            <div className="my-4 flex items-center">
              <div className="flex-grow border-t border-gray-300"></div>
              <span className="px-3 text-sm text-gray-500">{t('auth.login.or', 'or')}</span>
              <div className="flex-grow border-t border-gray-300"></div>
            </div>
          )}
        </div>
      )}

      {/* Username/Password Form - show if local auth OR LDAP auth is enabled */}
      {hasUsernamePasswordAuth && (
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* LDAP Provider Selection - only show if multiple LDAP providers */}
          {hasLdapAuth && ldapProviders.length > 1 && (
            <div>
              <label htmlFor="provider" className="block text-sm font-medium text-gray-700 mb-1">
                {t('auth.login.ldapProvider', 'LDAP Provider')}
              </label>
              <select
                id="provider"
                name="provider"
                value={formData.provider}
                onChange={handleInputChange}
                disabled={isFormLoading}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed text-gray-900 bg-white"
              >
                <option value="">{t('auth.login.selectProvider', 'Auto-detect')}</option>
                {ldapProviders.map(provider => (
                  <option key={provider.name} value={provider.name}>
                    {provider.displayName || provider.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
              {t('auth.login.username', 'Username or Email')}
            </label>
            <input
              type="text"
              id="username"
              name="username"
              value={formData.username}
              onChange={handleInputChange}
              required
              disabled={isFormLoading}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed text-gray-900 bg-white"
              placeholder={t('auth.login.usernamePlaceholder', 'Enter your username or email')}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              {t('auth.login.password', 'Password')}
            </label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleInputChange}
              required
              disabled={isFormLoading}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed text-gray-900 bg-white"
              placeholder={t('auth.login.passwordPlaceholder', 'Enter your password')}
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
                  {t('auth.login.signingIn', 'Signing In...')}
                </>
              ) : (
                t('auth.menu.signIn', 'Sign In')
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

      {/* Show demo accounts only if local auth is enabled and configured to show */}
      {hasLocalAuth && showDemoAccounts && (
        <div className="mt-6 text-xs text-gray-500 text-center">
          <p>Demo accounts:</p>
          <p>Admin: admin / password123</p>
          <p>User: user / password123</p>
        </div>
      )}

      {/* Show message if no auth methods are available */}
      {!hasUsernamePasswordAuth && !hasOidcProviders && !hasNtlmAuth && (
        <div className="text-center text-gray-500">
          <p>No authentication methods are currently enabled.</p>
          <p className="text-sm mt-2">Please contact your administrator.</p>
        </div>
      )}
    </div>
  );
};

export default LoginForm;
