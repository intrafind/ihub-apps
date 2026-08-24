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

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
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
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
            onChange={e => updateLocalAuth('sessionTimeoutMinutes', parseInt(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
              checked={config.localAuth?.showDemoAccounts || false}
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
      </div>
    </div>
  );
}

export default LocalAuthSection;
