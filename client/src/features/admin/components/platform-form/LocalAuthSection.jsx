/**
 * LocalAuthSection - Built-in username/password authentication settings.
 */
function LocalAuthSection({ config, onChange }) {
  const updateLocalAuth = (field, value) => {
    onChange({
      ...config,
      localAuth: {
        ...config.localAuth,
        [field]: value
      }
    });
  };

  const lockout = config.localAuth?.lockout || {};
  const updateLockout = (field, value) =>
    updateLocalAuth('lockout', { ...lockout, [field]: value });
  // An emptied number field drops the setting, so the server default applies.
  const updateLockoutNumber = (field, text) =>
    updateLockout(field, text === '' ? undefined : Number.parseInt(text, 10));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Local Authentication Settings
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Users File Path
          </label>
          <input
            type="text"
            value={config.localAuth?.usersFile || ''}
            onChange={e => updateLocalAuth('usersFile', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="contents/config/users.json"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Session Timeout (minutes)
          </label>
          <input
            type="number"
            value={config.localAuth?.sessionTimeoutMinutes || ''}
            onChange={e =>
              updateLocalAuth('sessionTimeoutMinutes', Number.parseInt(e.target.value))
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="480"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            JWT Secret
          </label>
          <input
            type="text"
            value={config.localAuth?.jwtSecret || ''}
            onChange={e => updateLocalAuth('jwtSecret', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="${JWT_SECRET}"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Use environment variable ${'{JWT_SECRET}'} for security
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={config.localAuth?.showDemoAccounts !== false}
              onChange={e => updateLocalAuth('showDemoAccounts', e.target.checked)}
              className="mr-2"
            />
            <span className="text-sm font-medium text-gray-700">
              Show Demo Accounts in Login Form
            </span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Display demo account credentials on the login form for development/testing
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={lockout.enabled !== false}
              onChange={e => updateLockout('enabled', e.target.checked)}
              className="mr-2"
            />
            <span className="text-sm font-medium text-gray-700">
              Lock accounts after repeated failed sign-ins
            </span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            While an account is locked, sign-in is refused without checking the password
          </p>
        </div>
        <div>
          <label
            htmlFor="local-auth-lockout-max-attempts"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Failed Sign-ins Before Lockout
          </label>
          <input
            id="local-auth-lockout-max-attempts"
            type="number"
            min="1"
            value={lockout.maxAttempts ?? ''}
            onChange={e => updateLockoutNumber('maxAttempts', e.target.value)}
            disabled={lockout.enabled === false}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="5"
          />
        </div>
        <div>
          <label
            htmlFor="local-auth-lockout-duration"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Lockout Duration (minutes)
          </label>
          <input
            id="local-auth-lockout-duration"
            type="number"
            min="1"
            value={lockout.durationMinutes ?? ''}
            onChange={e => updateLockoutNumber('durationMinutes', e.target.value)}
            disabled={lockout.enabled === false}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="15"
          />
        </div>
      </div>
    </div>
  );
}

export default LocalAuthSection;
