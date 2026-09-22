import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import IntegrationTestResults from '../IntegrationTestResults';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../../api/adminApi';

/**
 * Dry-runs an LDAP login against the provider currently shown in the form.
 *
 * The provider is sent inline, so a configuration can be tried out before it is
 * saved. The password is optional: with a bind account configured the server
 * can look the user up without it and still report the attributes, the LDAP
 * groups and the internal groups they map to — only the "would this password be
 * accepted" step is then skipped. Nothing is persisted by the test.
 */
function LdapLoginTest({ provider }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);

    try {
      const response = await makeAdminApiCall('/admin/auth/ldap/_test', {
        method: 'POST',
        body: { provider, username: username.trim(), password }
      });
      setResult(response.data);
    } catch (error) {
      setResult({ success: false, message: getAdminApiErrorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 sm:text-sm';

  return (
    <div className="md:col-span-2 mt-2 p-4 rounded-md border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40">
      <h5 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.auth.ldap.test.title', 'Test a login')}
      </h5>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
        {t(
          'admin.auth.ldap.test.help',
          'Runs this configuration against the directory and shows what would be found and mapped. Nothing is saved, no session is created. With a bind account, the password is optional.'
        )}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <div>
          <label
            htmlFor={`ldap-test-username-${provider?.name || 'new'}`}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.auth.ldap.test.username', 'Username')}
          </label>
          <input
            id={`ldap-test-username-${provider?.name || 'new'}`}
            type="text"
            autoComplete="off"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label
            htmlFor={`ldap-test-password-${provider?.name || 'new'}`}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.auth.ldap.test.password', 'Password (optional)')}
          </label>
          <input
            id={`ldap-test-password-${provider?.name || 'new'}`}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={runTest}
            disabled={testing || username.trim().length === 0}
            className="w-full px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 text-sm font-medium disabled:opacity-50"
          >
            {testing ? (
              <>
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block align-middle" />
                {t('admin.auth.ldap.test.running', 'Testing…')}
              </>
            ) : (
              <>
                <Icon name="play" className="h-4 w-4 inline-block mr-1" />
                {t('admin.auth.ldap.test.run', 'Test login')}
              </>
            )}
          </button>
        </div>
      </div>

      {result && (
        <div className="mt-4">
          <IntegrationTestResults
            title={t('admin.auth.ldap.test.resultTitle', 'LDAP login test')}
            result={result}
          />
        </div>
      )}
    </div>
  );
}

export default LdapLoginTest;
