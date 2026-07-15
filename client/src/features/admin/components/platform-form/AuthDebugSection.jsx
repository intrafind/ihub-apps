const DEBUG_PROVIDERS = ['oidc', 'local', 'proxy', 'ldap', 'ntlm'];

/**
 * AuthDebugSection - Toggles for logging authentication events per provider,
 * for troubleshooting login issues.
 */
function AuthDebugSection({ config, onChange }) {
  const updateAuthDebugConfig = (field, value) => {
    onChange({
      ...config,
      authDebug: {
        ...config.authDebug,
        [field]: value
      }
    });
  };

  const updateAuthDebugProvider = (provider, field, value) => {
    onChange({
      ...config,
      authDebug: {
        ...config.authDebug,
        providers: {
          ...config.authDebug?.providers,
          [provider]: {
            ...config.authDebug?.providers?.[provider],
            [field]: value
          }
        }
      }
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Debug Settings</h3>
        <p className="text-sm text-gray-600 mt-1">
          Enable detailed logging for authentication providers to troubleshoot issues.
          <span className="text-amber-600 font-medium ml-1">
            Warning: This may log sensitive information.
          </span>
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-start space-x-3">
          <div className="flex items-center h-5">
            <input
              type="checkbox"
              checked={config.authDebug?.enabled || false}
              onChange={e => updateAuthDebugConfig('enabled', e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
          </div>
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-900">
              Enable Authentication Debug Logging
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Log authentication events, token exchanges, and user information for troubleshooting
            </p>
          </div>
        </div>

        {config.authDebug?.enabled && (
          <div className="ml-6 space-y-4 pl-4 border-l-2 border-gray-200">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.authDebug?.maskTokens !== false}
                    onChange={e => updateAuthDebugConfig('maskTokens', e.target.checked)}
                    className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">Mask Tokens</span>
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                  Hide sensitive parts of access tokens and secrets
                </p>
              </div>

              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.authDebug?.redactPasswords !== false}
                    onChange={e => updateAuthDebugConfig('redactPasswords', e.target.checked)}
                    className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">Redact Passwords</span>
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                  Remove passwords and credentials from logs
                </p>
              </div>

              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.authDebug?.consoleLogging || false}
                    onChange={e => updateAuthDebugConfig('consoleLogging', e.target.checked)}
                    className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">Console Logging</span>
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                  Also output debug logs to console
                </p>
              </div>

              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.authDebug?.includeRawData || false}
                    onChange={e => updateAuthDebugConfig('includeRawData', e.target.checked)}
                    className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">Include Raw Data</span>
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                  Include unsanitized raw data (security risk)
                </p>
              </div>
            </div>

            {/* Provider-specific settings */}
            <div className="pt-4 border-t border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">Provider Settings</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {DEBUG_PROVIDERS.map(provider => (
                  <div key={provider} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id={`debug-${provider}`}
                      checked={config.authDebug?.providers?.[provider]?.enabled !== false}
                      onChange={e => updateAuthDebugProvider(provider, 'enabled', e.target.checked)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <label htmlFor={`debug-${provider}`} className="text-sm text-gray-700">
                      {provider.toUpperCase()}
                    </label>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Enable debug logging per authentication provider
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AuthDebugSection;
