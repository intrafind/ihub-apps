// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, INPUT_CLASS } from '../formStyles';

/**
 * LocalAuthSection - Built-in username/password authentication settings.
 */
function LocalAuthSection({ config, onChange }) {
  const { t } = useTranslation();
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
        {t('admin.auth.local.title', 'Local Authentication Settings')}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.auth.local.usersFile', 'Users File Path')}
          </label>
          <input
            type="text"
            value={config.localAuth?.usersFile || ''}
            onChange={e => updateLocalAuth('usersFile', e.target.value)}
            className={INPUT_CLASS}
            placeholder="contents/config/users.json"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.auth.sessionTimeout', 'Session Timeout (minutes)')}
          </label>
          <input
            type="number"
            value={config.localAuth?.sessionTimeoutMinutes || ''}
            onChange={e =>
              updateLocalAuth('sessionTimeoutMinutes', Number.parseInt(e.target.value))
            }
            className={INPUT_CLASS}
            placeholder="480"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.auth.local.jwtSecret', 'JWT Secret')}
          </label>
          <input
            type="text"
            value={config.localAuth?.jwtSecret || ''}
            onChange={e => updateLocalAuth('jwtSecret', e.target.value)}
            className={INPUT_CLASS}
            placeholder="${JWT_SECRET}"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t(
              'admin.auth.local.jwtSecretHelp',
              'Use the environment variable {{name}} for security',
              {
                name: '${JWT_SECRET}'
              }
            )}
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={config.localAuth?.showDemoAccounts !== false}
              onChange={e => updateLocalAuth('showDemoAccounts', e.target.checked)}
              className={`${CHECKBOX_CLASS} mr-2`}
            />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.auth.local.showDemoAccounts', 'Show Demo Accounts in Login Form')}
            </span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t(
              'admin.auth.local.showDemoAccountsHelp',
              'Display demo account credentials on the login form for development/testing'
            )}
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={lockout.enabled !== false}
              onChange={e => updateLockout('enabled', e.target.checked)}
              className={`${CHECKBOX_CLASS} mr-2`}
            />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.auth.local.lockout', 'Lock accounts after repeated failed sign-ins')}
            </span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t(
              'admin.auth.local.lockoutHelp',
              'While an account is locked, sign-in is refused without checking the password'
            )}
          </p>
        </div>
        <div>
          <label
            htmlFor="local-auth-lockout-max-attempts"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.auth.local.lockoutMaxAttempts', 'Failed Sign-ins Before Lockout')}
          </label>
          <input
            id="local-auth-lockout-max-attempts"
            type="number"
            min="1"
            value={lockout.maxAttempts ?? ''}
            onChange={e => updateLockoutNumber('maxAttempts', e.target.value)}
            disabled={lockout.enabled === false}
            className={INPUT_CLASS}
            placeholder="5"
          />
        </div>
        <div>
          <label
            htmlFor="local-auth-lockout-duration"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.auth.local.lockoutDuration', 'Lockout Duration (minutes)')}
          </label>
          <input
            id="local-auth-lockout-duration"
            type="number"
            min="1"
            value={lockout.durationMinutes ?? ''}
            onChange={e => updateLockoutNumber('durationMinutes', e.target.value)}
            disabled={lockout.enabled === false}
            className={INPUT_CLASS}
            placeholder="15"
          />
        </div>
      </div>
    </div>
  );
}

export default LocalAuthSection;
